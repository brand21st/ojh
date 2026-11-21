import type { SupabaseClient } from "@supabase/supabase-js";
import { logError, logInfo } from "@/lib/logger";
import { fetchRazorpayOrderPayments } from "@/modules/razorpay/client";
import { isMissingRelation } from "@/modules/wallet/recharge";
import { expireReservations, fulfillRecharge, reconcileWallets } from "@/modules/wallet/service";
import { issuePendingRechargeInvoices } from "@/modules/wallet/invoices";

const RECHECK_AFTER_MS = 5 * 60 * 1000;
const GIVE_UP_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Finds recharges still waiting after the callback and webhook should have
 * arrived, asks Razorpay what happened, and credits any captured payment.
 * Crediting goes through the same once-only database function.
 */
export async function recoverPendingRecharges(
  db: SupabaseClient,
  options: { organizationId?: string; limit?: number; minAgeMs?: number; now?: Date } = {}
) {
  const now = options.now ?? new Date();
  const olderThan = new Date(now.getTime() - (options.minAgeMs ?? 2 * 60 * 1000)).toISOString();
  const newerThan = new Date(now.getTime() - GIVE_UP_AFTER_MS).toISOString();
  const recheckBefore = new Date(now.getTime() - RECHECK_AFTER_MS).toISOString();

  let query = db
    .from("wallet_recharge_orders")
    .select("razorpay_order_id, amount_paise, organization_id")
    .in("status", ["CREATED", "FAILED"])
    .lt("created_at", olderThan)
    .gt("created_at", newerThan)
    .or(`last_checked_at.is.null,last_checked_at.lt.${recheckBefore}`)
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(options.limit ?? 50, 200)));
  if (options.organizationId) query = query.eq("organization_id", options.organizationId);

  const { data, error } = await query;
  if (error) {
    if (!isMissingRelation(error)) logError("wallet.recover_list_failed", { message: error.message });
    return { checked: 0, credited: 0 };
  }

  let checked = 0;
  let credited = 0;
  for (const row of data ?? []) {
    const orderId = String(row.razorpay_order_id);
    try {
      const payments = await fetchRazorpayOrderPayments(orderId);
      const captured = payments.find(
        (item) => String(item.status) === "captured" && String(item.currency ?? "INR") === "INR"
      );
      if (captured) {
        const result = await fulfillRecharge(db, {
          razorpayOrderId: orderId,
          razorpayPaymentId: String(captured.id),
          amountPaise: Number(captured.amount),
          method: captured.method ? String(captured.method) : null,
          expectedOrganizationId: String(row.organization_id),
        });
        if (result.status === "CREDITED") credited += 1;
        if (result.status === "AMOUNT_MISMATCH") {
          logError("wallet.recover_amount_mismatch", { orderId, received: captured.amount });
        }
      }
      await db
        .from("wallet_recharge_orders")
        .update({ last_checked_at: now.toISOString() })
        .eq("razorpay_order_id", orderId);
      checked += 1;
    } catch (cause) {
      logError("wallet.recover_order_failed", {
        orderId,
        message: cause instanceof Error ? cause.message : "unknown",
      });
    }
  }
  if (credited) logInfo("wallet.recovered_recharges", { checked, credited });
  return { checked, credited };
}

/** The wallet cron: free expired holds, recover missed recharges, check every balance. */
export async function runWalletSweep(db: SupabaseClient) {
  const expired = await expireReservations(db, 1000).catch((cause) => {
    logError("wallet.expire_failed", { message: cause instanceof Error ? cause.message : "unknown" });
    return 0;
  });
  const recharges = await recoverPendingRecharges(db, { limit: 100 });
  const mismatches = await reconcileWallets(db).catch((cause) => {
    logError("wallet.reconcile_failed", { message: cause instanceof Error ? cause.message : "unknown" });
    return -1;
  });
  if (mismatches > 0) logError("wallet.reconcile_mismatch", { wallets: mismatches });
  // After recovery, so a recharge credited just now gets its invoice in the same run.
  const invoices = await issuePendingRechargeInvoices(db, 200);
  return { expired, recharges, mismatches, invoices };
}
