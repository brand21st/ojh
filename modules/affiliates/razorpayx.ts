import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { logError } from "@/lib/logger";
import { getRazorpayCredentials } from "@/modules/razorpay/config";

/**
 * RazorpayX (payouts) client for partner commission transfers.
 * Separate from platform billing: it moves money OUT of the RazorpayX current account.
 * Never log request bodies, VPAs or credentials.
 */
const API = "https://api.razorpay.com/v1";

export type ProviderPayout = { id: string; status: string; utr: string | null; failureReason: string | null };

export function razorpayxConfigured() {
  return Boolean(process.env.RAZORPAYX_ACCOUNT_NUMBER?.trim());
}

async function credentials() {
  const keyId = process.env.RAZORPAYX_KEY_ID?.trim();
  const secret = process.env.RAZORPAYX_KEY_SECRET?.trim();
  if (keyId && secret) return { keyId, secret };
  const fallback = await getRazorpayCredentials();
  if (!fallback.keyId || !fallback.secret) throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "RazorpayX is not configured.");
  return { keyId: fallback.keyId, secret: fallback.secret };
}

async function request<T extends Record<string, unknown>>(method: "GET" | "POST", path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}): Promise<T> {
  const { keyId, secret } = await credentials();
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}`, "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = json.error as { description?: string; code?: string } | undefined;
    const description = (error?.description || `RazorpayX request failed (${response.status}).`).replaceAll(secret, "[redacted]").slice(0, 300);
    logError("razorpayx.request_failed", { path: path.replace(/\/[a-z]+_[A-Za-z0-9]+$/, "/:id"), method, status: response.status, code: error?.code });
    throw new AppError(response.status >= 500 ? ERROR_CODES.INTEGRATION_NOT_CONNECTED : ERROR_CODES.VALIDATION_ERROR, description);
  }
  return json as T;
}

/** Narration allows letters, digits and spaces only, max 30 characters. */
export function payoutNarration(text: string) {
  return text.replace(/[^A-Za-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 30) || "PostBus Partner payout";
}

export async function ensureFundAccount(input: { name: string; upi: string; referenceId: string }) {
  const contact = await request<{ id: string }>("POST", "/contacts", {
    name: input.name.slice(0, 50),
    type: "vendor",
    reference_id: input.referenceId.slice(0, 40),
    notes: { source: "postbus-partner" },
  });
  const fund = await request<{ id: string }>("POST", "/fund_accounts", {
    contact_id: contact.id,
    account_type: "vpa",
    vpa: { address: input.upi },
  });
  return { contactId: contact.id, fundAccountId: fund.id };
}

function toPayout(json: Record<string, unknown>): ProviderPayout {
  const details = json.status_details as { description?: string } | undefined;
  return {
    id: String(json.id),
    status: String(json.status ?? ""),
    utr: typeof json.utr === "string" && json.utr ? json.utr : null,
    failureReason: (typeof json.failure_reason === "string" && json.failure_reason) || details?.description || null,
  };
}

/** The idempotency key makes a retried call return the same payout instead of sending twice. */
export async function createPayout(input: { fundAccountId: string; amountPaise: number; idempotencyKey: string; narration: string; referenceId: string }) {
  if (!razorpayxConfigured()) throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "RAZORPAYX_ACCOUNT_NUMBER is not set.");
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Invalid payout amount.");
  const json = await request<Record<string, unknown>>(
    "POST",
    "/payouts",
    {
      account_number: process.env.RAZORPAYX_ACCOUNT_NUMBER!.trim(),
      fund_account_id: input.fundAccountId,
      amount: input.amountPaise,
      currency: "INR",
      mode: "UPI",
      purpose: "payout",
      queue_if_low_balance: true,
      reference_id: input.referenceId.slice(0, 40),
      narration: payoutNarration(input.narration),
      notes: { source: "postbus-partner" },
    },
    { "X-Payout-Idempotency": input.idempotencyKey },
  );
  return toPayout(json);
}

export async function fetchPayout(id: string) {
  if (!/^pout_[A-Za-z0-9]+$/.test(id)) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Invalid payout id.");
  return toPayout(await request<Record<string, unknown>>("GET", `/payouts/${id}`));
}

/** Map RazorpayX payout statuses onto our settlement events. Null = still in flight. */
export function settlementEvent(status: string): "processed" | "failed" | "rejected" | "cancelled" | "reversed" | null {
  switch (status) {
    case "processed": return "processed";
    case "failed": return "failed";
    case "rejected": return "rejected";
    case "cancelled": return "cancelled";
    case "reversed": return "reversed";
    default: return null; // queued, pending, scheduled, processing
  }
}
