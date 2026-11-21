import type { SupabaseClient } from "@supabase/supabase-js";
import { logError, logInfo } from "@/lib/logger";
import { isMissingRelation } from "@/modules/wallet/recharge";
import { fulfillRecharge, markRechargeFailed, reverseRecharge } from "@/modules/wallet/service";
import { issueRechargeInvoice } from "@/modules/wallet/invoices";

type Payload = { event?: string; payload?: Record<string, unknown> };
type Entity = Record<string, unknown>;

function entity(payload: Payload, name: string): Entity {
  const wrapper = payload.payload?.[name] as { entity?: Entity } | undefined;
  return wrapper?.entity ?? {};
}

async function rechargeExists(db: SupabaseClient, column: "razorpay_order_id" | "razorpay_payment_id", value: string) {
  const { data, error } = await db
    .from("wallet_recharge_orders")
    .select("id")
    .eq(column, value)
    .maybeSingle();
  if (error) {
    // Before the wallet migration is applied nothing can be a recharge.
    if (isMissingRelation(error)) return false;
    // Anything else must not fall through to subscription handling, which
    // would mark the event processed and lose the credit. Fail so Razorpay retries.
    throw new Error(`wallet recharge lookup failed: ${error.message}`);
  }
  return Boolean(data);
}

/**
 * Handles platform Razorpay events that belong to wallet recharges.
 * Returns null for everything else so subscription, add-on and AI credit
 * handling run exactly as before.
 */
export async function handleWalletRazorpayEvent(db: SupabaseClient, payload: Payload) {
  const event = payload.event ?? "";
  const payment = entity(payload, "payment");
  const order = entity(payload, "order");
  const refund = entity(payload, "refund");

  if (event === "payment.captured" || event === "order.paid") {
    const orderId = String(payment.order_id ?? order.id ?? "");
    if (!orderId || !(await rechargeExists(db, "razorpay_order_id", orderId))) return null;
    if (String(payment.status ?? "captured") !== "captured" || !payment.id) {
      return { ignored: true, wallet: true };
    }
    if (String(payment.currency ?? "INR") !== "INR") {
      logError("wallet.webhook_currency_rejected", { orderId, currency: payment.currency });
      return { ignored: true, wallet: true };
    }
    const result = await fulfillRecharge(db, {
      razorpayOrderId: orderId,
      razorpayPaymentId: String(payment.id),
      amountPaise: Number(payment.amount),
      method: payment.method ? String(payment.method) : null,
    });
    if (result.status === "AMOUNT_MISMATCH") {
      logError("wallet.webhook_amount_mismatch", { orderId, received: payment.amount });
      return { ignored: true, wallet: true };
    }
    logInfo("wallet.webhook_recharge", { event, orderId, status: result.status });
    if (result.raw.rechargeOrderId) await issueRechargeInvoice(db, String(result.raw.rechargeOrderId));
    if (result.status === "CREDITED" && result.snapshot?.organizationId) {
      const { resumeHeldWhatsappNotices } = await import("@/modules/wallet/whatsapp-billing");
      await resumeHeldWhatsappNotices({ organizationId: result.snapshot.organizationId, limit: 200 }).catch(() => undefined);
    }
    return { processed: true, wallet: true, status: result.status };
  }

  if (event === "payment.failed") {
    const orderId = String(payment.order_id ?? "");
    if (!orderId || !(await rechargeExists(db, "razorpay_order_id", orderId))) return null;
    const reason = String(payment.error_description ?? payment.error_reason ?? "Payment failed");
    const result = await markRechargeFailed(db, orderId, reason);
    return { processed: true, wallet: true, status: result.status };
  }

  if (event === "refund.processed") {
    const paymentId = String(refund.payment_id ?? payment.id ?? "");
    if (!paymentId || !(await rechargeExists(db, "razorpay_payment_id", paymentId))) return null;
    if (!refund.id || !Number.isSafeInteger(Number(refund.amount)) || Number(refund.amount) <= 0) {
      logError("wallet.webhook_refund_malformed", { paymentId });
      return { ignored: true, wallet: true };
    }
    const result = await reverseRecharge(db, {
      razorpayPaymentId: paymentId,
      refundId: String(refund.id),
      refundPaise: Number(refund.amount),
    });
    if (result.raw.frozen === true) {
      logError("wallet.frozen_after_refund", { paymentId, organizationId: result.snapshot?.organizationId });
    }
    return { processed: true, wallet: true, status: result.status };
  }

  return null;
}
