import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { logError } from "@/lib/logger";
import type { MerchantPaymentMode } from "../credentials";

/**
 * MERCHANT STOREFRONT PAYMENTS (Domain B) ONLY.
 *
 * A Cashfree Payment Gateway client bound to ONE merchant's Client ID / Client Secret, passed in
 * explicitly. There are no default credentials and no environment variables: a merchant without
 * a configuration can never fall back to any PostBus account.
 *
 * TEST mode talks to the Cashfree Sandbox, LIVE mode to Cashfree Production. The two are never
 * mixed: the base URL is chosen only from the mode stored with the merchant's credentials.
 */

export const CASHFREE_API_VERSION = "2026-01-01";
export const CASHFREE_BASE_URL: Record<MerchantPaymentMode, string> = {
  TEST: "https://sandbox.cashfree.com/pg",
  LIVE: "https://api.cashfree.com/pg",
};
const REQUEST_TIMEOUT_MS = 15_000;

export type MerchantCashfreeCredentials = { clientId: string; clientSecret: string; mode: MerchantPaymentMode };

export type CashfreeOrder = {
  cf_order_id?: string | number | null;
  order_id: string;
  order_amount: number;
  order_currency: string;
  order_status: string;
  payment_session_id?: string | null;
  order_tags?: Record<string, string> | null;
};

export type CashfreePayment = {
  cf_payment_id: string | number;
  order_id?: string | null;
  payment_status: string;
  payment_amount: number;
  payment_currency: string;
  payment_group?: string | null;
  payment_message?: string | null;
  payment_time?: string | null;
  payment_completion_time?: string | null;
  is_captured?: boolean | null;
  error_details?: { error_description?: string | null; error_reason?: string | null } | null;
};

export type CreateCashfreeOrderInput = {
  orderId: string;
  amountPaise: number;
  customer: { id: string; phone: string; name?: string | null; email?: string | null };
  notifyUrl: string;
  returnUrl?: string | null;
  note: string;
  tags: Record<string, string>;
  idempotencyKey: string;
};

export class CashfreeAuthError extends AppError {
  constructor() {
    super(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Cashfree rejected these credentials. Check the Client ID and Client Secret.");
  }
}

/** 403: the account or this API is not enabled (activation pending, PG not live, account disabled). */
export class CashfreeForbiddenError extends AppError {
  constructor(public readonly detail: string | null) {
    super(
      ERROR_CODES.INTEGRATION_NOT_CONNECTED,
      detail
        ? `Cashfree refused the request: ${detail}`
        : "Cashfree refused the request. Your account may not be activated for Payment Gateway in this environment."
    );
  }
}

export class CashfreeNotFoundError extends AppError {
  constructor() {
    super(ERROR_CODES.RESOURCE_NOT_FOUND, "Cashfree could not find this order.");
  }
}

/** 409, e.g. order_already_exists after a retried create. */
export class CashfreeConflictError extends AppError {
  constructor(public readonly cashfreeCode: string | null) {
    super(ERROR_CODES.CONFLICT, "Cashfree reports this order already exists.");
  }
}

export class CashfreeUnavailableError extends AppError {
  constructor(public readonly timedOut: boolean) {
    super(
      ERROR_CODES.PROVIDER_ERROR,
      timedOut ? "Cashfree did not respond in time. Please try again." : "Could not reach Cashfree. Please try again."
    );
  }
}

export type MerchantCashfreeClient = ReturnType<typeof merchantCashfreeClient>;

/** Cashfree order_amount is in rupees (major units, ≤ 2 decimals). PostBus keeps integer paise. */
export function paiseToCashfreeAmount(paise: number) {
  if (!Number.isSafeInteger(paise) || paise <= 0) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Invalid payment amount.");
  return Number((paise / 100).toFixed(2));
}

/** Cashfree amount (rupees) → integer paise. Never trusts float artefacts beyond 2 decimals. */
export function cashfreeAmountToPaise(amount: unknown) {
  const value = typeof amount === "string" ? Number(amount) : typeof amount === "number" ? amount : NaN;
  if (!Number.isFinite(value)) return NaN;
  return Math.round(value * 100);
}

export function merchantCashfreeClient(credentials: MerchantCashfreeCredentials, fetchImpl: typeof fetch = fetch) {
  if (!credentials.clientId || !credentials.clientSecret) {
    throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Online payments are not configured for this store.");
  }
  const baseUrl = CASHFREE_BASE_URL[credentials.mode];
  if (!baseUrl) throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Online payments are not configured for this store.");

  async function request<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          "x-client-id": credentials.clientId,
          "x-client-secret": credentials.clientSecret,
          "x-api-version": CASHFREE_API_VERSION,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      // Method, mode and path only: never headers (credentials) or the body (customer details).
      logError("merchant_cashfree.request_unreachable", { method, mode: credentials.mode, path: redactPath(path), timedOut });
      throw new CashfreeUnavailableError(timedOut);
    }
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message = safeMessage(json.message);
      const code = typeof json.code === "string" ? json.code : null;
      logError("merchant_cashfree.request_failed", { method, mode: credentials.mode, path: redactPath(path), status: response.status, code });
      if (response.status === 401) throw new CashfreeAuthError();
      if (response.status === 403) throw new CashfreeForbiddenError(message);
      if (response.status === 404) throw new CashfreeNotFoundError();
      if (response.status === 409) throw new CashfreeConflictError(code);
      if (response.status >= 500 || response.status === 429) throw new CashfreeUnavailableError(false);
      throw new AppError(ERROR_CODES.PROVIDER_ERROR, message || `Cashfree request failed (${response.status}).`);
    }
    return json as T;
  }

  return {
    mode: credentials.mode,
    /**
     * Read-only credential check: looks up an order id that cannot exist. Cashfree answers 404 for
     * valid credentials and 401 for invalid ones. Creates nothing in the merchant's account.
     */
    verify: async () => {
      try {
        await request<CashfreeOrder>("GET", `/orders/${encodeURIComponent("postbus_credential_check")}`);
      } catch (error) {
        if (error instanceof CashfreeNotFoundError) return { ok: true as const };
        throw error;
      }
      return { ok: true as const };
    },
    createOrder: (input: CreateCashfreeOrderInput) =>
      request<CashfreeOrder>(
        "POST",
        "/orders",
        {
          order_id: input.orderId,
          order_amount: paiseToCashfreeAmount(input.amountPaise),
          order_currency: "INR",
          customer_details: {
            customer_id: input.customer.id,
            customer_phone: input.customer.phone,
            ...(input.customer.name && input.customer.name.length >= 3 ? { customer_name: input.customer.name.slice(0, 100) } : {}),
            ...(input.customer.email ? { customer_email: input.customer.email.slice(0, 100) } : {}),
          },
          order_meta: {
            notify_url: input.notifyUrl,
            ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
          },
          order_note: input.note.slice(0, 200),
          order_tags: input.tags,
        },
        input.idempotencyKey
      ),
    getOrder: (orderId: string) => request<CashfreeOrder>("GET", `/orders/${encodeURIComponent(orderId)}`),
    getOrderPayments: async (orderId: string) => {
      const result = await request<CashfreePayment[] | { data?: CashfreePayment[] }>("GET", `/orders/${encodeURIComponent(orderId)}/payments`);
      return Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [];
    },
  };
}

function redactPath(path: string) {
  return path.replace(/\/orders\/[^/]+/, "/orders/…");
}

function safeMessage(value: unknown) {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, 200);
  // Never echo anything that looks like key material back to the dashboard or logs.
  return /cfsk_|secret|x-client/i.test(text) ? null : text || null;
}
