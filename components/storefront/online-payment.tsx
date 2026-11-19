"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, CreditCard, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/hooks/use-api";
import { formatStorePrice } from "@/modules/storefront/pricing";

/** Session returned by the server for the MERCHANT's Razorpay order. Holds no secret. */
export type RazorpayCheckoutSession = {
  provider: "RAZORPAY";
  keyId: string;
  razorpayOrderId: string;
  amountPaise: number;
  currency: "INR";
  mode: "TEST" | "LIVE";
  orderId: string;
  token: string;
};

/** Session for the MERCHANT's Cashfree order. payment_session_id is not a credential. */
export type CashfreeCheckoutSession = {
  provider: "CASHFREE";
  paymentSessionId: string;
  environment: "sandbox" | "production";
  cashfreeOrderId: string;
  amountPaise: number;
  currency: "INR";
  mode: "TEST" | "LIVE";
  orderId: string;
  token: string;
};

export type OnlineCheckoutSession = RazorpayCheckoutSession | CashfreeCheckoutSession;

export type OnlinePaymentHandle = {
  orderId: string;
  token: string;
  session: OnlineCheckoutSession | null;
  error: string | null;
};

type StoreRef = { workspace?: string; publicId?: string; token?: string };
type PaymentStatus = "CREATED" | "FAILED" | "CANCELLED" | "PROCESSING" | "AUTHORIZED" | "PAID" | "REFUNDED";
type BuyerState = { orderId: string; status: PaymentStatus; amountPaise: number; method: string | null; failureReason: string | null };

type RazorpaySuccess = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
type RazorpayInstance = { open: () => void; on: (event: string, handler: (response: { error?: { description?: string } }) => void) => void };
type CashfreeCheckoutResult = { error?: { message?: string } | null; redirect?: boolean; paymentDetails?: { paymentMessage?: string } | null };
type CashfreeInstance = { checkout: (options: { paymentSessionId: string; redirectTarget: "_modal" | "_self" }) => Promise<CashfreeCheckoutResult> };
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
    Cashfree?: (options: { mode: "sandbox" | "production" }) => CashfreeInstance;
  }
}

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
// Cashfree's official JS SDK (v3) for Hosted Checkout.
const CASHFREE_SRC = "https://sdk.cashfree.com/js/v3/cashfree.js";

function loadScript(src: string, ready: () => boolean) {
  if (typeof window === "undefined") return Promise.reject(new Error("Checkout needs a browser."));
  if (ready()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src='${src}']`);
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Could not load the payment window. Check your connection and try again.")), { once: true });
    if (!existing) {
      script.src = src;
      script.async = true;
      document.body.appendChild(script);
    } else if (ready()) {
      resolve();
    }
  });
}

/** Removes the Cashfree SDK's modal (and its backdrop) when it cannot finish loading. */
function closeCashfreeModal() {
  document.getElementById("cashfree-modal-container")?.remove();
}

const loadCheckout = () => loadScript(CHECKOUT_SRC, () => Boolean(window.Razorpay));
const loadCashfree = () => loadScript(CASHFREE_SRC, () => Boolean(window.Cashfree));

function paymentCall<T>(apiRef: StoreRef, body: Record<string, unknown>) {
  return api<T>("/api/v1/public/store/payment", {
    method: "POST",
    body: JSON.stringify({ workspace: apiRef.workspace, code: apiRef.publicId, token: apiRef.token, ...body }),
  });
}

/**
 * Pays an already-placed storefront order through the merchant's own gateway (Razorpay Checkout or
 * Cashfree Hosted Checkout). The order is only shown as paid after the server has verified the
 * payment with that gateway's API.
 */
export function OnlinePaymentPanel({
  apiRef,
  handle,
  storeName,
  accent,
  customer,
  onStatus,
}: {
  apiRef: StoreRef;
  handle: OnlinePaymentHandle;
  storeName: string;
  accent: string;
  customer: { name: string; phone: string };
  onStatus?: (status: PaymentStatus) => void;
}) {
  const [session, setSession] = useState<OnlineCheckoutSession | null>(handle.session);
  const [state, setState] = useState<BuyerState | null>(null);
  const [busy, setBusy] = useState<"opening" | "verifying" | "checking" | null>(null);
  const [message, setMessage] = useState<string | null>(handle.error);
  const [blocked, setBlocked] = useState(false);
  const autoOpened = useRef(false);
  const restoredChecked = useRef(false);
  const status: PaymentStatus = state?.status ?? "CREATED";
  const amountPaise = session?.amountPaise ?? state?.amountPaise ?? 0;

  useEffect(() => {
    if (state) onStatus?.(state.status);
  }, [state, onStatus]);

  const checkStatus = useCallback(async () => {
    setBusy("checking");
    try {
      const result = await paymentCall<{ state: BuyerState }>(apiRef, { action: "status", orderId: handle.orderId, paymentToken: handle.token });
      setState(result.state);
      if (result.state.status === "PAID") setMessage(null);
      return result.state;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not check the payment. Try again.");
      return null;
    } finally {
      setBusy(null);
    }
  }, [apiRef, handle.orderId, handle.token]);

  const confirm = useCallback(
    async (response: RazorpaySuccess) => {
      setBusy("verifying");
      setMessage(null);
      try {
        const result = await paymentCall<{ state: BuyerState }>(apiRef, {
          action: "confirm",
          orderId: handle.orderId,
          paymentToken: handle.token,
          razorpayOrderId: response.razorpay_order_id,
          razorpayPaymentId: response.razorpay_payment_id,
          razorpaySignature: response.razorpay_signature,
        });
        setState(result.state);
        if (result.state.status !== "PAID") {
          setMessage("Your bank is still confirming this payment. We'll update the order as soon as it's done.");
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "We could not verify the payment yet.");
        // The webhook or the server sweep may still confirm it; show the latest truth.
        await checkStatus();
      } finally {
        setBusy(null);
      }
    },
    [apiRef, handle.orderId, handle.token, checkStatus]
  );

  /** Cashfree: the checkout result is only a hint. The server re-checks with Cashfree's API. */
  const verifyCashfree = useCallback(
    async (closedWithError: boolean) => {
      setBusy("verifying");
      try {
        const result = await paymentCall<{ state: BuyerState }>(apiRef, { action: "verify", orderId: handle.orderId, paymentToken: handle.token });
        setState(result.state);
        if (result.state.status === "PAID") setMessage(null);
        else if (result.state.status === "PROCESSING") setMessage("Your bank is still confirming this payment. We'll update the order as soon as it's done.");
        else if (closedWithError || result.state.status === "FAILED" || result.state.status === "CANCELLED") {
          setMessage(result.state.failureReason || "Payment was not completed. You can try again.");
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "We could not verify the payment yet.");
      } finally {
        setBusy(null);
      }
    },
    [apiRef, handle.orderId, handle.token]
  );

  const pay = useCallback(async () => {
    setBusy("opening");
    setMessage(null);
    try {
      let active = session;
      if (!active) {
        const resumed = await paymentCall<{ state: BuyerState; session: OnlineCheckoutSession | null }>(apiRef, {
          action: "resume",
          orderId: handle.orderId,
          paymentToken: handle.token,
          returnUrl: typeof window !== "undefined" ? window.location.href : undefined,
        });
        setState(resumed.state);
        if (!resumed.session) {
          setBusy(null);
          return;
        }
        active = resumed.session;
        setSession(active);
      }
      if (active.provider === "CASHFREE") {
        await loadCashfree();
        if (!window.Cashfree) throw new Error("Could not load the payment window.");
        const cashfree = window.Cashfree({ mode: active.environment });
        setBusy(null);
        setBlocked(false);
        // If the browser blocks Cashfree's payment page (stale page policy, extension, network
        // filter) the SDK leaves an empty white modal forever. Detect it, close the modal and tell
        // the customer how to recover instead of leaving them stuck.
        let onBlocked: (event: SecurityPolicyViolationEvent) => void = () => undefined;
        const blockedSignal = new Promise<"blocked">((resolve) => {
          onBlocked = (event) => {
            if (/cashfree\.com/i.test(event.blockedURI || "")) resolve("blocked");
          };
          document.addEventListener("securitypolicyviolation", onBlocked);
        });
        const outcome = await Promise.race([
          cashfree.checkout({ paymentSessionId: active.paymentSessionId, redirectTarget: "_modal" }),
          blockedSignal,
        ]).finally(() => document.removeEventListener("securitypolicyviolation", onBlocked));
        // Any retry gets a fresh session from the server (Get Order).
        setSession(null);
        if (outcome === "blocked") {
          closeCashfreeModal();
          setBlocked(true);
          setMessage("Your browser blocked the payment window. Reload this page, then tap Pay again. Your order is saved.");
          return;
        }
        const result = outcome;
        // In-app browsers redirect instead; the receipt is restored when the customer returns.
        if (result?.redirect) return;
        await verifyCashfree(Boolean(result?.error));
        return;
      }
      await loadCheckout();
      if (!window.Razorpay) throw new Error("Could not load the payment window.");
      const checkout = new window.Razorpay({
        key: active.keyId,
        order_id: active.razorpayOrderId,
        amount: active.amountPaise,
        currency: active.currency,
        name: storeName,
        description: "Order payment",
        prefill: { name: customer.name, contact: customer.phone },
        theme: { color: accent },
        handler: (response: RazorpaySuccess) => void confirm(response),
        modal: {
          ondismiss: () => {
            setBusy(null);
            void checkStatus();
          },
        },
      });
      checkout.on("payment.failed", (response) => {
        setMessage(response.error?.description || "Payment failed. You can try again.");
      });
      checkout.open();
      setBusy(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open the payment window.");
      setBusy(null);
    }
  }, [accent, apiRef, checkStatus, confirm, customer.name, customer.phone, handle.orderId, handle.token, session, storeName, verifyCashfree]);

  useEffect(() => {
    if (autoOpened.current || !handle.session) return;
    autoOpened.current = true;
    void pay();
  }, [handle.session, pay]);

  // Restored after a redirect checkout or a reload: ask the server for the verified status.
  useEffect(() => {
    if (restoredChecked.current || handle.session || handle.error) return;
    restoredChecked.current = true;
    void checkStatus();
  }, [checkStatus, handle.error, handle.session]);

  const processing = status === "AUTHORIZED" || status === "PROCESSING";

  if (status === "PAID") {
    return (
      <div className="mt-4 flex items-start gap-2 rounded-2xl bg-emerald-50 px-3 py-3 text-left text-sm text-emerald-900" role="status">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          <span className="block font-semibold">Payment received{amountPaise ? ` · ${formatStorePrice(amountPaise / 100)}` : ""}</span>
          <span className="block text-xs text-emerald-800">Your order is confirmed. The store will ship it soon.</span>
        </span>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-2xl border border-zinc-200 px-3 py-3 text-left text-sm" aria-live="polite">
      <p className="flex items-center gap-2 font-semibold text-zinc-900">
        <CreditCard className="size-4 shrink-0" aria-hidden />
        {processing ? "Payment processing" : "Payment pending"}
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        {processing
          ? "Your bank is processing the payment. We'll confirm the order once it settles."
          : "Complete the payment to confirm your order. UPI, cards, net banking and wallets are accepted."}
      </p>
      {message ? <p className="mt-2 rounded-xl bg-amber-50 px-2.5 py-2 text-xs font-medium text-amber-950">{message}</p> : null}
      {blocked ? (
        // This page cannot open the payment window again; a reload restores this receipt.
        <Button type="button" className="mt-3 h-11 w-full rounded-xl" onClick={() => window.location.reload()}>
          <RefreshCw className="size-4" aria-hidden />
          Reload and pay
        </Button>
      ) : !processing ? (
        <Button type="button" className="mt-3 h-11 w-full rounded-xl" onClick={() => void pay()} disabled={busy !== null}>
          {busy === "opening" || busy === "verifying" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ShieldCheck className="size-4" aria-hidden />}
          {busy === "verifying" ? "Verifying payment…" : amountPaise ? `Pay ${formatStorePrice(amountPaise / 100)} securely` : "Pay securely"}
        </Button>
      ) : null}
      <button
        type="button"
        className="mt-2 inline-flex w-full items-center justify-center gap-1.5 text-xs font-medium text-zinc-600 underline-offset-2 hover:underline disabled:opacity-50"
        onClick={() => void checkStatus()}
        disabled={busy !== null}
      >
        <RefreshCw className={busy === "checking" ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
        Already paid? Check payment status
      </button>
    </div>
  );
}
