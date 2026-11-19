import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { hashSecret } from "@/lib/security/crypto";
import type { MerchantPaymentMode } from "../credentials";

const CLIENT_ID = /^[A-Za-z0-9_\-]{6,100}$/;
const CLIENT_SECRET = /^[A-Za-z0-9_\-]{16,200}$/;

/** Cashfree's dashboard labels: Sandbox (TEST) and Production (LIVE). */
export function cashfreeEnvironmentLabel(mode: MerchantPaymentMode) {
  return mode === "LIVE" ? "Production" : "Sandbox";
}

/**
 * Shape check before any network call. Cashfree secret keys carry an environment marker
 * (`…_test_…` for Sandbox, `…_prod_…` for Production); when present it must match the chosen
 * environment. The authoritative check is still the call to Cashfree itself.
 */
export function validateCashfreeCredentials(input: { clientId: string; clientSecret: string; mode: MerchantPaymentMode }) {
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret.trim();
  if (!CLIENT_ID.test(clientId)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Enter your Cashfree Client ID (App ID) exactly as the Cashfree dashboard shows it.");
  }
  if (!CLIENT_SECRET.test(clientSecret)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Enter your Cashfree Client Secret exactly as the Cashfree dashboard shows it.");
  }
  const marker = /_(test|prod)_/i.exec(clientSecret)?.[1]?.toLowerCase();
  if (marker === "test" && input.mode === "LIVE") {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "This is a Sandbox (test) secret, but Production is selected. Choose Sandbox or use your Production keys.");
  }
  if (marker === "prod" && input.mode === "TEST") {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "This is a Production secret, but Sandbox is selected. Choose Production or use your Sandbox keys.");
  }
  return { clientId, clientSecret };
}

/** Identifies the Cashfree account + environment that created a payment attempt. */
export function cashfreeFingerprint(clientId: string, mode: MerchantPaymentMode) {
  return hashSecret(`postbus.merchant-cashfree.client.v1\0${mode}\0${clientId}`);
}

/** TEST••••Ab12 — safe to show in the dashboard. */
export function cashfreeClientIdHint(clientId: string) {
  if (clientId.length <= 8) return "••••";
  return `${clientId.slice(0, 4)}••••${clientId.slice(-4)}`;
}
