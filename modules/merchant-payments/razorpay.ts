import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { logError } from "@/lib/logger";

/**
 * MERCHANT STOREFRONT PAYMENTS (Domain B) ONLY.
 *
 * A Razorpay HTTP client bound to ONE merchant's keys, passed in explicitly. It deliberately has
 * no default credentials and never imports modules/razorpay/config or client (PostBus SaaS
 * billing), so a missing merchant configuration can never fall back to the PostBus account.
 */

const RAZORPAY_API = "https://api.razorpay.com/v1";
const REQUEST_TIMEOUT_MS = 15_000;

export type MerchantRazorpayCredentials = { keyId: string; keySecret: string };
export type RazorpayEntity = Record<string, unknown>;

export type MerchantRazorpayOrder = { id: string; amount: number; currency: string; status: string; receipt?: string | null };
export type MerchantRazorpayPayment = {
  id: string;
  order_id?: string | null;
  amount: number;
  currency: string;
  status: string;
  method?: string | null;
  captured?: boolean;
  error_description?: string | null;
  error_reason?: string | null;
  amount_refunded?: number;
  refund_status?: string | null;
};

export class MerchantRazorpayAuthError extends AppError {
  constructor() {
    super(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Razorpay rejected these API keys. Check the Key ID and Key Secret.");
  }
}

export type MerchantRazorpayClient = ReturnType<typeof merchantRazorpayClient>;

export function merchantRazorpayClient(credentials: MerchantRazorpayCredentials, fetchImpl: typeof fetch = fetch) {
  if (!credentials.keyId || !credentials.keySecret) {
    throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Online payments are not configured for this store.");
  }
  const authorization = `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64")}`;

  async function request<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${RAZORPAY_API}${path}`, {
        method,
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      // Path only: never the Authorization header or body.
      logError("merchant_razorpay.request_unreachable", { method, path: redactPath(path), timedOut });
      throw new AppError(
        ERROR_CODES.PROVIDER_ERROR,
        timedOut ? "Razorpay did not respond in time. Please try again." : "Could not reach Razorpay. Please try again."
      );
    }
    const json = (await response.json().catch(() => ({}))) as RazorpayEntity;
    if (!response.ok) {
      const description = (json.error as { description?: string } | undefined)?.description;
      logError("merchant_razorpay.request_failed", { method, path: redactPath(path), status: response.status });
      if (response.status === 401) throw new MerchantRazorpayAuthError();
      throw new AppError(ERROR_CODES.PROVIDER_ERROR, safeDescription(description) || `Razorpay request failed (${response.status}).`);
    }
    return json as T;
  }

  return {
    keyId: credentials.keyId,
    /** Read-only call used to prove the keys work. Creates nothing in the merchant's account. */
    verify: () => request<{ count?: number }>("GET", "/orders?count=1"),
    createOrder: (input: { amountPaise: number; receipt: string; notes: Record<string, string> }) =>
      request<MerchantRazorpayOrder>("POST", "/orders", {
        amount: input.amountPaise,
        currency: "INR",
        receipt: input.receipt,
        payment_capture: 1,
        notes: input.notes,
      }),
    fetchOrder: (orderId: string) => request<MerchantRazorpayOrder>("GET", `/orders/${encodeURIComponent(orderId)}`),
    fetchOrderPayments: (orderId: string) =>
      request<{ items?: MerchantRazorpayPayment[] }>("GET", `/orders/${encodeURIComponent(orderId)}/payments`),
    fetchPayment: (paymentId: string) => request<MerchantRazorpayPayment>("GET", `/payments/${encodeURIComponent(paymentId)}`),
  };
}

function redactPath(path: string) {
  return path.replace(/\/(order|pay)_[A-Za-z0-9]+/g, "/$1_…");
}

function safeDescription(value: unknown) {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, 200);
  // Razorpay descriptions never need to echo key material; drop anything that looks like a key.
  return /rzp_(test|live)_/i.test(text) ? null : text;
}
