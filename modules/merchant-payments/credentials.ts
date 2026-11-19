import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { decryptSecret, encryptSecret, hashSecret } from "@/lib/security/crypto";

export type MerchantPaymentMode = "TEST" | "LIVE";

const KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]{8,40}$/;
const SECRET = /^[A-Za-z0-9_\-]{8,128}$/;

export function modeOfKeyId(keyId: string): MerchantPaymentMode | null {
  const match = KEY_ID.exec(keyId);
  if (!match) return null;
  return match[1] === "live" ? "LIVE" : "TEST";
}

/** Validates the shape of merchant keys and that the Key ID belongs to the chosen mode. */
export function validateRazorpayKeys(input: { keyId: string; keySecret: string; mode: MerchantPaymentMode }) {
  const keyId = input.keyId.trim();
  const keySecret = input.keySecret.trim();
  const keyMode = modeOfKeyId(keyId);
  if (!keyMode) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Enter a valid Razorpay Key ID. It starts with rzp_test_ or rzp_live_.");
  }
  if (keyMode !== input.mode) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      keyMode === "LIVE"
        ? "This is a Live Key ID, but Test mode is selected. Choose Live mode or use your rzp_test_ keys."
        : "This is a Test Key ID, but Live mode is selected. Choose Test mode or use your rzp_live_ keys."
    );
  }
  if (!SECRET.test(keySecret)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Enter the Key Secret exactly as Razorpay shows it.");
  }
  return { keyId, keySecret };
}

export function validateWebhookSecret(value: string) {
  const secret = value.trim();
  if (secret.length < 8 || secret.length > 256 || /\s/.test(secret)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Webhook secret must be 8–256 characters with no spaces.");
  }
  return secret;
}

export function keyFingerprint(keyId: string) {
  return hashSecret(`postbus.merchant-razorpay.key.v1\0${keyId}`);
}

/** rzp_test_••••Ab12. Safe to show in the dashboard. */
export function keyIdHint(keyId: string) {
  const match = /^(rzp_(?:test|live)_)(.*)$/.exec(keyId);
  if (!match) return "••••";
  return `${match[1]}••••${match[2].slice(-4)}`;
}

export const sealSecret = encryptSecret;

export function openSecret(payload: string | null | undefined) {
  if (!payload) return null;
  try {
    return decryptSecret(payload);
  } catch {
    // Wrong INTEGRATION_ENCRYPTION_KEY or tampered value. Treat as missing, never as plaintext.
    return null;
  }
}
