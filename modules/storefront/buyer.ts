import { randomBytes, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { generateOtpDigits } from "@/lib/auth/otp/crypto";
import { vachatOtpTemplateName } from "@/lib/auth/otp/secrets";
import { logInfo } from "@/lib/logger";
import { extractIndiaMobileDigits, toIndiaWhatsappE164 } from "@/lib/phone/india-whatsapp";
import { hashSecret, hmacSha256 } from "@/lib/security/crypto";

/** httpOnly cookie holding this browser's random device token. */
export const BUYER_COOKIE = "pb_buyer";
export const BUYER_DEVICE_TTL_DAYS = 180;
export const CHECKOUT_CODE_TTL_MS = 5 * 60 * 1000;
export const CHECKOUT_CODE_COOLDOWN_MS = 60 * 1000;
const SEND_WINDOW_MS = 15 * 60 * 1000;
const PHONE_SENDS_PER_WINDOW = 5;
const IP_SENDS_PER_WINDOW = 10;
const MAX_CODE_ATTEMPTS = 5;
const MAX_SAVED_ADDRESSES = 5;
const DAY_MS = 86_400_000;

export type SavedBuyerAddress = {
  id: string;
  customerName: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
};

export type BuyerLookup =
  | { status: "new" }
  | { status: "verify" }
  | { status: "ready"; addresses: SavedBuyerAddress[] };

export type BuyerAddressInput = {
  customerName: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  pincode: string;
};

export type CodeSender = (phoneE164: string, code: string) => Promise<void>;

export function normalizeBuyerPhone(raw: string) {
  const phone = extractIndiaMobileDigits(raw);
  if (!phone) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Enter a valid 10-digit WhatsApp number.");
  return phone;
}

export function newDeviceToken() {
  return randomBytes(32).toString("base64url");
}

/** Ignore anything in the cookie that this server could not have issued. */
export function readDeviceToken(value: string | null | undefined) {
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function buyerAddressFingerprint(address: BuyerAddressInput) {
  const norm = (value: string | null | undefined) => (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return hashSecret([address.line1, address.line2, address.city, address.state, address.pincode].map(norm).join("|"));
}

function codeHash(organizationId: string, phone: string, code: string) {
  return hmacSha256(`storefront-checkout:${organizationId}:${phone}:${code}`);
}

function hashesMatch(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function dbError(error: { message: string } | null) {
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
}

function mapAddress(row: Record<string, unknown>): SavedBuyerAddress {
  return {
    id: String(row.id),
    customerName: String(row.customer_name ?? ""),
    line1: String(row.line1 ?? ""),
    line2: (row.line2 as string | null) || null,
    city: String(row.city ?? ""),
    state: String(row.state ?? ""),
    pincode: String(row.pincode ?? ""),
  };
}

export async function listBuyerAddresses(supabase: SupabaseClient, organizationId: string, phone: string) {
  const { data, error } = await supabase
    .from("storefront_buyer_addresses")
    .select("id, customer_name, line1, line2, city, state, pincode")
    .eq("organization_id", organizationId)
    .eq("phone", phone)
    .order("last_used_at", { ascending: false })
    .limit(MAX_SAVED_ADDRESSES);
  dbError(error);
  return (data ?? []).map((row) => mapAddress(row as Record<string, unknown>));
}

async function isDeviceTrusted(supabase: SupabaseClient, organizationId: string, phone: string, token: string | null, now: Date) {
  if (!token) return false;
  const { data, error } = await supabase
    .from("storefront_buyer_devices")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("phone", phone)
    .eq("token_hash", hashSecret(token))
    .gt("expires_at", now.toISOString())
    .maybeSingle();
  dbError(error);
  if (!data) return false;
  await supabase.from("storefront_buyer_devices").update({ last_used_at: now.toISOString() }).eq("id", data.id);
  return true;
}

async function trustDevice(supabase: SupabaseClient, organizationId: string, phone: string, token: string, now: Date) {
  const { error } = await supabase.from("storefront_buyer_devices").upsert(
    {
      organization_id: organizationId,
      phone,
      token_hash: hashSecret(token),
      expires_at: new Date(now.getTime() + BUYER_DEVICE_TTL_DAYS * DAY_MS).toISOString(),
      last_used_at: now.toISOString(),
    },
    { onConflict: "organization_id,phone,token_hash" }
  );
  dbError(error);
}

/**
 * What checkout should show for a WhatsApp number. Addresses are only returned to a
 * browser that has already proved it owns the number; otherwise the buyer verifies.
 */
export async function lookupBuyer(
  supabase: SupabaseClient,
  organizationId: string,
  rawPhone: string,
  token: string | null,
  now = new Date()
): Promise<BuyerLookup> {
  const phone = normalizeBuyerPhone(rawPhone);
  const addresses = await listBuyerAddresses(supabase, organizationId, phone);
  if (!addresses.length) return { status: "new" };
  if (await isDeviceTrusted(supabase, organizationId, phone, token, now)) return { status: "ready", addresses };
  return { status: "verify" };
}

/** Production sends through the WhatsApp OTP template; development without one logs the code. */
export async function sendCheckoutCodeViaWhatsapp(phoneE164: string, code: string) {
  if (vachatOtpTemplateName()) {
    const { sendWhatsappOtp } = await import("@/lib/auth/otp/send-whatsapp");
    await sendWhatsappOtp(phoneE164, code);
    return;
  }
  if (process.env.NODE_ENV !== "production") {
    logInfo("storefront.checkout_code.dev", { phone: phoneE164, code });
    return;
  }
  throw new AppError(ERROR_CODES.PROVIDER_ERROR, "WhatsApp codes are not available right now. Enter your address instead.");
}

export async function requestCheckoutCode(
  supabase: SupabaseClient,
  input: { organizationId: string; phone: string; ip: string; now?: Date; send?: CodeSender }
) {
  const now = input.now ?? new Date();
  const phone = normalizeBuyerPhone(input.phone);
  const addresses = await listBuyerAddresses(supabase, input.organizationId, phone);
  if (!addresses.length) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "No saved details for this number. Enter your address to continue.");

  const ipHash = hashSecret(`storefront-checkout-ip:${input.ip}`);
  const windowStart = new Date(now.getTime() - SEND_WINDOW_MS).toISOString();
  const [{ data: recent, error: recentError }, { count: ipCount, error: ipError }] = await Promise.all([
    supabase
      .from("storefront_checkout_otps")
      .select("created_at")
      .eq("organization_id", input.organizationId)
      .eq("phone", phone)
      .gte("created_at", windowStart)
      .order("created_at", { ascending: false }),
    supabase.from("storefront_checkout_otps").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("created_at", windowStart),
  ]);
  dbError(recentError);
  dbError(ipError);
  const last = recent?.[0]?.created_at ? new Date(String(recent[0].created_at)).getTime() : 0;
  const wait = last + CHECKOUT_CODE_COOLDOWN_MS - now.getTime();
  if (wait > 0) throw new AppError(ERROR_CODES.RATE_LIMITED, `Wait ${Math.ceil(wait / 1000)} seconds before asking for another code.`);
  if ((recent?.length ?? 0) >= PHONE_SENDS_PER_WINDOW || (ipCount ?? 0) >= IP_SENDS_PER_WINDOW) {
    throw new AppError(ERROR_CODES.RATE_LIMITED, "Too many codes requested. Try again in 15 minutes, or enter your address.");
  }

  const code = generateOtpDigits();
  const { data: row, error } = await supabase
    .from("storefront_checkout_otps")
    .insert({
      organization_id: input.organizationId,
      phone,
      code_hash: codeHash(input.organizationId, phone, code),
      ip_hash: ipHash,
      expires_at: new Date(now.getTime() + CHECKOUT_CODE_TTL_MS).toISOString(),
      created_at: now.toISOString(),
    })
    .select("id")
    .single();
  dbError(error);
  try {
    await (input.send ?? sendCheckoutCodeViaWhatsapp)(toIndiaWhatsappE164(phone), code);
  } catch (sendError) {
    await supabase.from("storefront_checkout_otps").delete().eq("id", row!.id);
    if (sendError instanceof AppError) throw sendError;
    throw new AppError(ERROR_CODES.PROVIDER_ERROR, "Could not send the code. Enter your address instead.");
  }
  return { sent: true as const, resendInSeconds: CHECKOUT_CODE_COOLDOWN_MS / 1000 };
}

export async function verifyCheckoutCode(
  supabase: SupabaseClient,
  input: { organizationId: string; phone: string; code: string; token: string | null; now?: Date }
) {
  const now = input.now ?? new Date();
  const phone = normalizeBuyerPhone(input.phone);
  const code = input.code.replace(/\D/g, "");
  const invalid = () => new AppError(ERROR_CODES.VALIDATION_ERROR, "That code is wrong or has expired.");
  const { data: otp, error } = await supabase
    .from("storefront_checkout_otps")
    .select("id, code_hash, attempts, expires_at")
    .eq("organization_id", input.organizationId)
    .eq("phone", phone)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  dbError(error);
  if (!otp || new Date(String(otp.expires_at)).getTime() <= now.getTime()) throw invalid();
  if (Number(otp.attempts) >= MAX_CODE_ATTEMPTS) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Too many wrong codes. Ask for a new code.");
  }
  await supabase.from("storefront_checkout_otps").update({ attempts: Number(otp.attempts) + 1 }).eq("id", otp.id);
  if (code.length !== 6 || !hashesMatch(codeHash(input.organizationId, phone, code), String(otp.code_hash))) throw invalid();

  await supabase.from("storefront_checkout_otps").update({ consumed_at: now.toISOString() }).eq("id", otp.id);
  const token = input.token ?? newDeviceToken();
  await trustDevice(supabase, input.organizationId, phone, token, now);
  return { token, addresses: await listBuyerAddresses(supabase, input.organizationId, phone) };
}

/**
 * Save the address a buyer just ordered to, and trust this browser for the number.
 * The browser typed the full address itself, so it learns nothing new.
 */
export async function rememberBuyer(
  supabase: SupabaseClient,
  input: { organizationId: string; phone: string; address: BuyerAddressInput; token: string | null; now?: Date }
) {
  const now = input.now ?? new Date();
  const phone = normalizeBuyerPhone(input.phone);
  const address = input.address;
  const { error } = await supabase.from("storefront_buyer_addresses").upsert(
    {
      organization_id: input.organizationId,
      phone,
      customer_name: address.customerName.trim(),
      line1: address.line1.trim(),
      line2: address.line2?.trim() || null,
      city: address.city.trim(),
      state: address.state.trim(),
      pincode: address.pincode.trim(),
      fingerprint: buyerAddressFingerprint(address),
      last_used_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
    { onConflict: "organization_id,phone,fingerprint" }
  );
  dbError(error);

  const { data: extra } = await supabase
    .from("storefront_buyer_addresses")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("phone", phone)
    .order("last_used_at", { ascending: false })
    .range(MAX_SAVED_ADDRESSES, MAX_SAVED_ADDRESSES + 20);
  if (extra?.length) await supabase.from("storefront_buyer_addresses").delete().in("id", extra.map((row) => row.id));

  const token = input.token ?? newDeviceToken();
  await trustDevice(supabase, input.organizationId, phone, token, now);
  return { token };
}

/** Remove one saved address; only a browser trusted for the number may do this. */
export async function forgetBuyerAddress(
  supabase: SupabaseClient,
  input: { organizationId: string; phone: string; addressId: string; token: string | null; now?: Date }
) {
  const now = input.now ?? new Date();
  const phone = normalizeBuyerPhone(input.phone);
  if (!(await isDeviceTrusted(supabase, input.organizationId, phone, input.token, now))) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Verify your number to manage saved addresses.");
  }
  const { error } = await supabase
    .from("storefront_buyer_addresses")
    .delete()
    .eq("organization_id", input.organizationId)
    .eq("phone", phone)
    .eq("id", input.addressId);
  dbError(error);
  return { addresses: await listBuyerAddresses(supabase, input.organizationId, phone) };
}

export function buyerCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: BUYER_DEVICE_TTL_DAYS * 24 * 60 * 60,
  };
}
