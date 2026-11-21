import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret } from "@/lib/security/crypto";
import { logError } from "@/lib/logger";
import { payoutsEnabled } from "./policy";
import { checked } from "./service";
import * as razorpayx from "./razorpayx";

export type PayoutClient = Pick<typeof razorpayx, "createPayout" | "fetchPayout" | "ensureFundAccount" | "razorpayxConfigured" | "settlementEvent">;
export type EngineResult = { created: number; sent: number; failed: number; polled: number; skipped?: string };

const SEND_BATCH = 10;
const POLL_BATCH = 20;
const POLL_AFTER_MS = 30 * 60000;
const MAX_SEND_ATTEMPTS = 3;

/** Calendar date in India. Payout day and month boundaries follow IST, not server time. */
export function istDate(now: Date) {
  const ist = new Date(now.getTime() + 330 * 60000);
  return { year: ist.getUTCFullYear(), month: ist.getUTCMonth() + 1, day: ist.getUTCDate() };
}

/**
 * Runs from the billing cron. Order matters:
 * 1. poll in-flight payouts (settles only, never sends; runs even when automation is off),
 * 2. create this month's automatic requests on/after the payout day,
 * 3. send APPROVED RazorpayX requests. A retried send reuses the request id as the
 *    RazorpayX idempotency key, so a crash between "sent" and "recorded" cannot pay twice.
 */
export async function runPayoutEngine(db: SupabaseClient, opts: { now?: Date; client?: PayoutClient } = {}): Promise<EngineResult> {
  const now = opts.now ?? new Date();
  const client = opts.client ?? razorpayx;
  const result: EngineResult = { created: 0, sent: 0, failed: 0, polled: 0 };
  if (!payoutsEnabled()) return { ...result, skipped: "PAYOUTS_DISABLED" };
  if (!client.razorpayxConfigured()) return { ...result, skipped: "RAZORPAYX_NOT_CONFIGURED" };

  result.polled = await pollProcessing(db, client, now);

  const settings = checked(await db.from("affiliate_settings").select("auto_payout_enabled,auto_payout_day").single()) as { auto_payout_enabled: boolean; auto_payout_day: number };
  if (!settings?.auto_payout_enabled) return { ...result, skipped: "AUTO_PAYOUT_OFF" };

  const today = istDate(now);
  if (today.day >= settings.auto_payout_day) {
    const month = `${today.year}-${String(today.month).padStart(2, "0")}-01`;
    result.created = Number(checked(await db.rpc("affiliate_auto_request_payouts", { p_month: month })) ?? 0);
  }

  const queue = checked(
    await db
      .from("affiliate_payout_requests")
      .select("id,affiliate_id,account_id,amount_paise")
      .eq("status", "APPROVED")
      .eq("send_via", "RAZORPAYX")
      .is("provider_payout_id", null)
      .order("created_at", { ascending: true })
      .limit(SEND_BATCH)
  ) as { id: string; affiliate_id: string; account_id: string; amount_paise: number }[];

  for (const payout of queue ?? []) {
    try {
      const fundAccountId = await fundAccountFor(db, client, payout.account_id);
      const sent = await client.createPayout({
        fundAccountId,
        amountPaise: Number(payout.amount_paise),
        idempotencyKey: payout.id,
        referenceId: payout.id,
        narration: "PostBus partner payout",
      });
      checked(await db.rpc("affiliate_mark_processing", { p_id: payout.id, p_provider_id: sent.id, p_provider_status: sent.status }));
      const event = client.settlementEvent(sent.status);
      if (event) checked(await db.rpc("affiliate_provider_settle", { p_provider_id: sent.id, p_event: event, p_utr: sent.utr ?? "", p_reason: sent.failureReason ?? "" }));
      result.sent++;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Payout could not be sent.";
      logError("affiliate.payout_send_failed", { payout: payout.id });
      const status = checked(await db.rpc("affiliate_record_send_failure", { p_id: payout.id, p_reason: reason, p_max_attempts: MAX_SEND_ATTEMPTS }));
      if (status === "FAILED") result.failed++;
    }
  }
  return result;
}

async function pollProcessing(db: SupabaseClient, client: PayoutClient, now: Date) {
  const stale = checked(
    await db
      .from("affiliate_payout_requests")
      .select("id,provider_payout_id")
      .eq("status", "PROCESSING")
      .lt("sent_at", new Date(now.getTime() - POLL_AFTER_MS).toISOString())
      .order("sent_at", { ascending: true })
      .limit(POLL_BATCH)
  ) as { id: string; provider_payout_id: string }[];
  let polled = 0;
  for (const row of stale ?? []) {
    try {
      const remote = await client.fetchPayout(row.provider_payout_id);
      const event = client.settlementEvent(remote.status);
      if (event) checked(await db.rpc("affiliate_provider_settle", { p_provider_id: row.provider_payout_id, p_event: event, p_utr: remote.utr ?? "", p_reason: remote.failureReason ?? "" }));
      polled++;
    } catch {
      logError("affiliate.payout_poll_failed", { payout: row.id });
    }
  }
  return polled;
}

async function fundAccountFor(db: SupabaseClient, client: PayoutClient, accountId: string) {
  const cached = checked(await db.from("affiliate_razorpay_accounts").select("fund_account_id").eq("account_id", accountId).maybeSingle()) as { fund_account_id: string } | null;
  if (cached?.fund_account_id) return cached.fund_account_id;
  const account = checked(await db.from("affiliate_payout_accounts").select("id,encrypted_details").eq("id", accountId).single()) as { id: string; encrypted_details: string };
  const details = JSON.parse(decryptSecret(account.encrypted_details)) as { name: string; upi: string };
  const created = await client.ensureFundAccount({ name: details.name, upi: details.upi, referenceId: account.id });
  checked(await db.from("affiliate_razorpay_accounts").upsert({ account_id: account.id, contact_id: created.contactId, fund_account_id: created.fundAccountId }, { onConflict: "account_id", ignoreDuplicates: true }));
  return created.fundAccountId;
}
