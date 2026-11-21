import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { logError, logInfo } from "@/lib/logger";
import { writeBillingAudit } from "@/modules/billing/audit";
import { createRazorpayOrder, fetchRazorpayPayment } from "@/modules/razorpay/client";
import { getRazorpayConfig } from "@/modules/razorpay/config";
import { verifyOrderCheckoutSignature } from "@/modules/razorpay/signature";
import {
  DEFAULT_RECHARGE_MAX_PAISE,
  DEFAULT_RECHARGE_MIN_PAISE,
  DEFAULT_RECHARGE_PRESETS_PAISE,
  WALLET_RECHARGE_PURPOSE,
  walletEnabled,
} from "@/modules/wallet/constants";
import { quoteRecharge, validateRechargeAmount, type RechargeLimits } from "@/modules/wallet/recharge-quote";
import { fulfillRecharge } from "@/modules/wallet/service";
import { issueRechargeInvoice } from "@/modules/wallet/invoices";

const DEFAULT_GST_RATE_BPS = 1800;

export function isMissingRelation(error: { code?: string } | null | undefined) {
  return error?.code === "42P01" || error?.code === "PGRST205" || error?.code === "42703" || error?.code === "PGRST204";
}

export async function loadRechargeLimits(db: SupabaseClient): Promise<RechargeLimits> {
  const fallback: RechargeLimits = {
    presetsPaise: [...DEFAULT_RECHARGE_PRESETS_PAISE],
    minPaise: DEFAULT_RECHARGE_MIN_PAISE,
    maxPaise: DEFAULT_RECHARGE_MAX_PAISE,
    gstRateBps: DEFAULT_GST_RATE_BPS,
    placeOfSupply: "INTRA",
  };
  const { data, error } = await db
    .from("platform_settings")
    .select(
      "wallet_recharge_presets_paise, wallet_recharge_min_paise, wallet_recharge_max_paise, wallet_gst_rate_bps, wallet_gst_place_of_supply"
    )
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    if (!isMissingRelation(error)) logError("wallet.limits_load_failed", { message: error.message });
    return fallback;
  }
  if (!data) return fallback;
  const minPaise = Number(data.wallet_recharge_min_paise ?? fallback.minPaise);
  const maxPaise = Number(data.wallet_recharge_max_paise ?? fallback.maxPaise);
  const presets = (Array.isArray(data.wallet_recharge_presets_paise) ? data.wallet_recharge_presets_paise : fallback.presetsPaise)
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value >= minPaise && value <= maxPaise)
    .sort((a, b) => a - b);
  return {
    presetsPaise: presets,
    minPaise,
    maxPaise,
    gstRateBps: Number(data.wallet_gst_rate_bps ?? DEFAULT_GST_RATE_BPS),
    placeOfSupply: data.wallet_gst_place_of_supply === "INTER" ? "INTER" : "INTRA",
  };
}

export async function startWalletRecharge(
  db: SupabaseClient,
  input: {
    organizationId: string;
    organizationName: string;
    email?: string | null;
    userId: string;
    amountPaise: unknown;
    ip?: string | null;
  }
) {
  if (!walletEnabled()) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Wallet recharges are not open yet.");
  }
  const limits = await loadRechargeLimits(db);
  const checked = validateRechargeAmount(input.amountPaise, limits);
  if (!checked.ok) throw new AppError(ERROR_CODES.VALIDATION_ERROR, checked.message);

  const razorpay = await getRazorpayConfig();
  if (!razorpay.keyId || !razorpay.keySecret) {
    throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Payments are not configured yet.");
  }

  const order = await createRazorpayOrder({
    amountPaise: checked.amountPaise,
    receipt: `wal_${input.organizationId.replace(/-/g, "").slice(0, 12)}_${Date.now()}`.slice(0, 40),
    notes: { kind: WALLET_RECHARGE_PURPOSE, organization_id: input.organizationId },
  });
  const razorpayOrderId = String(order.id ?? "");
  if (!razorpayOrderId) throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Razorpay did not return an order.");

  const { data, error } = await db.rpc("wallet_create_recharge_order", {
    p_org: input.organizationId,
    p_razorpay_order_id: razorpayOrderId,
    p_amount_paise: checked.amountPaise,
    p_created_by: input.userId,
  });
  if (error) {
    logError("wallet.recharge_order_failed", { message: error.message, organizationId: input.organizationId });
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Could not start the recharge. Try again.");
  }
  const result = (data ?? {}) as Record<string, unknown>;
  if (result.status !== "CREATED") {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "This recharge amount is not allowed.");
  }

  await writeBillingAudit(db, {
    actorId: input.userId,
    actorType: "USER",
    action: "wallet.recharge_started",
    targetType: "wallet_recharge_order",
    targetId: String(result.rechargeOrderId ?? ""),
    organizationId: input.organizationId,
    ip: input.ip,
    metadata: { razorpayOrderId, amountPaise: checked.amountPaise },
  });

  return {
    keyId: razorpay.keyId,
    razorpayOrderId,
    amountPaise: checked.amountPaise,
    currency: "INR",
    name: "PostBus",
    description: "Wallet recharge",
    prefill: { email: input.email ?? "", name: input.organizationName },
    taxablePaise: Number(result.taxablePaise),
    taxPaise: Number(result.taxPaise),
    creditMicros: String(result.creditMicros),
  };
}

/**
 * The browser callback. The signature proves the ids came from Razorpay
 * checkout, and the payment is then read back from Razorpay itself; only a
 * captured payment for this exact order credits the wallet.
 */
export async function verifyWalletRecharge(
  db: SupabaseClient,
  input: {
    organizationId: string;
    userId: string;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    signature: string;
    ip?: string | null;
  }
) {
  const razorpay = await getRazorpayConfig();
  if (!razorpay.keySecret) throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Payments are not configured yet.");
  const valid = verifyOrderCheckoutSignature({
    orderId: input.razorpayOrderId,
    paymentId: input.razorpayPaymentId,
    signature: input.signature,
    secret: razorpay.keySecret,
  });
  if (!valid) throw new AppError(ERROR_CODES.FORBIDDEN, "Invalid payment signature.");

  const payment = await fetchRazorpayPayment(input.razorpayPaymentId);
  if (String(payment.order_id ?? "") !== input.razorpayOrderId) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "This payment is for a different order.");
  }
  if (String(payment.currency ?? "INR") !== "INR") {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Only INR payments can recharge the wallet.");
  }
  const status = String(payment.status ?? "");
  if (status === "authorized") {
    // Razorpay captures automatically; the payment.captured webhook credits it.
    return { status: "PENDING" as const };
  }
  if (status !== "captured") {
    throw new AppError(ERROR_CODES.PROVIDER_ERROR, "The payment was not completed.");
  }

  const result = await fulfillRecharge(db, {
    razorpayOrderId: input.razorpayOrderId,
    razorpayPaymentId: input.razorpayPaymentId,
    amountPaise: Number(payment.amount),
    method: payment.method ? String(payment.method) : null,
    expectedOrganizationId: input.organizationId,
  });

  if (result.status === "FORBIDDEN") throw new AppError(ERROR_CODES.FORBIDDEN, "This payment does not belong to your workspace.");
  if (result.status === "NOT_FOUND") throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Recharge not found.");
  if (result.status === "AMOUNT_MISMATCH") {
    logError("wallet.recharge_amount_mismatch", { orderId: input.razorpayOrderId, received: payment.amount });
    throw new AppError(ERROR_CODES.FORBIDDEN, "The paid amount does not match this recharge.");
  }

  await writeBillingAudit(db, {
    actorId: input.userId,
    actorType: "USER",
    action: "wallet.recharge_verified",
    targetType: "wallet_recharge_order",
    targetId: String(result.raw.rechargeOrderId ?? ""),
    organizationId: input.organizationId,
    ip: input.ip,
    metadata: { razorpayOrderId: input.razorpayOrderId, razorpayPaymentId: input.razorpayPaymentId, result: result.status },
  });
  logInfo("wallet.recharge_verified", { organizationId: input.organizationId, status: result.status });
  const rechargeOrderId = String(result.raw.rechargeOrderId ?? "");
  const invoice = rechargeOrderId ? await issueRechargeInvoice(db, rechargeOrderId) : null;

  return {
    status: "CREDITED" as const,
    duplicate: result.status === "DUPLICATE",
    balanceMicros: result.snapshot?.balanceMicros.toString() ?? null,
    invoiceNumber: invoice?.invoiceNumber ?? null,
  };
}

/** Shown before payment: what the merchant pays, the GST in it, and what reaches the wallet. */
export function previewRecharge(amountPaise: number, limits: RechargeLimits) {
  const checked = validateRechargeAmount(amountPaise, limits);
  if (!checked.ok) return { ok: false as const, message: checked.message };
  const quote = quoteRecharge(checked.amountPaise, limits.gstRateBps, limits.placeOfSupply);
  return { ok: true as const, ...quote, creditMicros: quote.creditMicros.toString() };
}
