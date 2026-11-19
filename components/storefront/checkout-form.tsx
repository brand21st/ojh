"use client";

import { useEffect, useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useForm, useWatch } from "react-hook-form";
import {
  BadgePercent,
  Banknote,
  ChevronDown,
  Loader2,
  Lock,
  MessageCircle,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Truck,
  Wallet,
} from "lucide-react";
import { CouponField, type QuoteCoupon } from "./coupon-field";
import { FastCheckoutDetails, checkoutSchema, rememberBuyerPhone, rememberedBuyerPhone, useFastCheckout, type CheckoutValues } from "./fast-checkout";
import { StoreImage } from "@/components/storefront/store-image";
import type { CartLine, StoreProduct } from "@/components/storefront/store-types";
import { api } from "@/lib/hooks/use-api";
import { DEFAULT_INDIAN_STATE } from "@/lib/indian-states";
import { returnPolicyLabel, summarizeReturnPolicy } from "@/modules/products/return-policy";
import { cartRequest } from "@/modules/storefront/cart";
import { onAccent, readableAccent } from "@/modules/storefront/config";
import { formatStorePrice } from "@/modules/storefront/pricing";

type StoreRef = { workspace?: string; publicId?: string; token?: string };
export type CheckoutStep = "details" | "summary";

type Quote = {
  total: number;
  subtotal?: number;
  discount?: number;
  amountDueNow: number;
  amountOnDelivery: number;
  expectedAdvance: number;
  quoteVersion: string;
  coupon?: QuoteCoupon | null;
  couponError?: string | null;
};

function formatPhone(digits: string) {
  return digits.length === 10 ? `+91 ${digits.slice(0, 5)} ${digits.slice(5)}` : `+91 ${digits}`;
}

function Card({ title, icon, children, id }: { title?: string; icon?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      {title ? (
        <h3 className="mb-3 flex items-center gap-2 text-[15px] font-bold text-zinc-900">
          {icon}
          {title}
        </h3>
      ) : null}
      {children}
    </section>
  );
}

function TrustRow() {
  const items = [
    { icon: ShieldCheck, label: "Secure checkout" },
    { icon: Truck, label: "India Post delivery" },
    { icon: MessageCircle, label: "WhatsApp updates" },
  ];
  return (
    <ul className="grid grid-cols-3 gap-2 text-center text-[11px] font-medium leading-4 text-zinc-500">
      {items.map(({ icon: Icon, label }) => (
        <li key={label} className="flex flex-col items-center gap-1.5">
          <span className="flex size-9 items-center justify-center rounded-full bg-zinc-100">
            <Icon className="size-4 text-zinc-600" aria-hidden />
          </span>
          {label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Phone-first, single-page checkout: the buyer enters a WhatsApp number (saved
 * addresses fill in by themselves), then reviews everything on one page.
 */
export function CheckoutForm({
  apiRef,
  workspace,
  accent,
  preview = false,
  cart,
  submitting,
  error,
  step,
  onStepChange,
  onSubmit,
  couponCode = null,
  skipAutoCoupon = false,
  onCouponApply,
  onCouponRemove,
  recommendations = [],
  onAdd,
  onlinePayment = false,
  onlinePaymentProvider = null,
}: {
  couponCode?: string | null;
  skipAutoCoupon?: boolean;
  onCouponApply?: (code: string) => void;
  onCouponRemove?: (automatic: boolean) => void;
  apiRef: StoreRef;
  workspace: string;
  accent: string;
  preview?: boolean;
  cart: CartLine[];
  submitting: boolean;
  error: string | null;
  step: CheckoutStep;
  onStepChange: (step: CheckoutStep) => void;
  onSubmit: (values: CheckoutValues) => Promise<void>;
  recommendations?: StoreProduct[];
  onAdd?: (product: StoreProduct) => void;
  /** The store takes payment through its own Razorpay account. */
  onlinePayment?: boolean;
  /** Which of the store's own gateways takes the payment, for the "secured by" line. */
  onlinePaymentProvider?: "RAZORPAY" | "CASHFREE" | null;
}) {
  const ink = readableAccent(accent);
  const form = useForm<CheckoutValues>({
    resolver: zodResolver(checkoutSchema),
    defaultValues: {
      customerName: "",
      // Checkout only renders in the browser, so the remembered number is safe to read here.
      phone: preview ? "" : rememberedBuyerPhone(workspace),
      line1: "",
      line2: "",
      city: "",
      state: DEFAULT_INDIAN_STATE,
      pincode: "",
      paymentPreference: cart.every((line) => line.product.codEnabled) ? "COD" : "PREPAID",
      saveAddress: true,
    },
  });
  const buyer = useFastCheckout({ form, apiRef, preview, workspace });
  const prepaid = cart.every((line) => line.product.prepaidEnabled);
  const cod = cart.every((line) => line.product.codEnabled);
  const preference = useWatch({ control: form.control, name: "paymentPreference" }) ?? (cod ? "COD" : "PREPAID");
  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  const productAmount = cart.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
  const mrpTotal = cart.reduce((sum, line) => sum + Math.max(line.product.compareAtPrice ?? 0, line.product.price) * line.quantity, 0);
  const mrpSavings = Math.max(0, mrpTotal - productAmount);
  const returns = summarizeReturnPolicy(cart.map((line) => line.product.returnAvailable !== false));
  // Set by the explicit Apply action so only that quote counts toward the coupon funnel.
  const trackApply = useRef(false);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const quote = useQuery({
    queryKey: ["store-quote", apiRef, preference, cart.map((line) => `${line.product.id}:${line.quantity}`).join(","), couponCode, skipAutoCoupon],
    enabled: !preview && Boolean(cart.length && (preference === "PREPAID" || preference === "COD") && (prepaid || cod)),
    queryFn: async () => {
      const track = trackApply.current;
      trackApply.current = false;
      const result = await api<Quote>("/api/v1/public/store/quote", {
        method: "POST",
        body: JSON.stringify({
          workspace: apiRef.workspace,
          code: apiRef.publicId,
          token: apiRef.token,
          paymentPreference: preference,
          ...cartRequest(cart),
          couponCode,
          skipAutoCoupon,
          trackCouponApply: track,
        }),
      });
      // A typed code that doesn't fit this cart is dropped so it can't block the order; the reason stays visible.
      if (result.couponError && couponCode) {
        setCouponError(result.couponError);
        onCouponRemove?.(false);
      }
      return result;
    },
  });
  const quotedCoupon = quote.data?.coupon ?? null;
  const couponDiscount = quotedCoupon?.applied ? quotedCoupon.discount : 0;
  const total = quote.data?.total ?? productAmount;
  const totalSavings = mrpSavings + couponDiscount;
  const codAdvance = preference === "COD" ? (quote.data?.amountDueNow ?? 0) : 0;

  // A buyer this browser already knows skips the number screen, once per number.
  const autoAdvancedFor = useRef<string | null>(null);
  useEffect(() => {
    if (step !== "details" || buyer.status !== "ready" || !buyer.addresses.length) return;
    if (autoAdvancedFor.current === buyer.phone) return;
    autoAdvancedFor.current = buyer.phone;
    onStepChange("summary");
  }, [buyer.addresses.length, buyer.phone, buyer.status, onStepChange, step]);

  const visibleRecommendations = onAdd ? recommendations.filter((item) => !cart.some((line) => line.product.id === item.id)).slice(0, 6) : [];

  async function handlePhoneContinue() {
    if (buyer.needsVerification) {
      buyer.continueVerification();
      return;
    }
    const valid = await form.trigger("phone");
    if (!valid || buyer.status === "checking") return;
    autoAdvancedFor.current = buyer.phone;
    onStepChange("summary");
    requestAnimationFrame(() => document.getElementById("checkout-scroll")?.scrollTo({ top: 0 }));
  }

  const submitOrder = form.handleSubmit(async (values) => {
    if (preview) return;
    const fresh = await quote.refetch();
    if (!fresh.data || fresh.error) return;
    if (fresh.data.quoteVersion !== quote.data?.quoteVersion) {
      form.setError("root", { message: "Prices changed. Review the updated total and place your order again." });
      return;
    }
    await onSubmit({ ...values, quoteVersion: fresh.data.quoteVersion });
  }, (errors) => {
    // The number lives on the first screen; send the buyer back there to fix it.
    if (errors.phone) onStepChange("details");
  });

  const rootError = quote.error?.message ?? form.formState.errors.root?.message;

  return (
    <form
      data-clarity-mask="true"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-zinc-50"
      onSubmit={(event) => {
        if (step === "details") {
          event.preventDefault();
          void handlePhoneContinue();
          return;
        }
        return submitOrder(event);
      }}
      noValidate
    >
      <div id="checkout-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {step === "details" ? (
          <div className="mx-auto flex max-w-md flex-col gap-4 px-4 py-5 md:py-8">
            <div className="flex items-center gap-3 rounded-2xl border border-zinc-200/80 bg-white p-3">
              <span className="flex -space-x-3">
                {cart.slice(0, 3).map((line) => (
                  <span key={line.product.id} className="relative size-10 overflow-hidden rounded-xl bg-zinc-100 ring-2 ring-white">
                    <StoreImage src={line.product.imageUrls[0]} alt="" sizes="40px" />
                  </span>
                ))}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-zinc-500">{itemCount} {itemCount === 1 ? "item" : "items"}</span>
                <span className="block text-sm font-bold text-zinc-900">
                  {mrpSavings > 0 ? <s className="mr-1.5 font-normal text-zinc-400">{formatStorePrice(mrpTotal)}</s> : null}
                  {formatStorePrice(productAmount)}
                </span>
              </span>
              {mrpSavings > 0 ? <span className="rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-bold text-emerald-700">Save {formatStorePrice(mrpSavings)}</span> : null}
            </div>

            <Card>
              <h3 className="text-lg font-bold text-zinc-900">Enter your mobile number</h3>
              <p className="mt-1 text-sm text-zinc-500">We&apos;ll fill in your saved address and send order updates on WhatsApp.</p>
              <div className="mt-4">
                <FastCheckoutDetails
                  form={form}
                  buyer={buyer}
                  apiRef={apiRef}
                  accent={accent}
                  part="phone"
                  onPhoneReset={() => {
                    rememberBuyerPhone(workspace, null);
                    form.setValue("phone", "");
                    requestAnimationFrame(() => document.getElementById("customer-phone")?.focus());
                  }}
                />
              </div>
            </Card>
            <div className="pt-2">
              <TrustRow />
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-lg flex-col gap-3 px-3 py-3 md:px-4 md:py-5">
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-200/80 bg-white px-4 py-3">
              <div className="min-w-0">
                <p className="text-xs text-zinc-500">Welcome</p>
                <p className="truncate text-sm font-bold tabular-nums text-zinc-900">{buyer.phone ? formatPhone(buyer.phone) : "Guest"}</p>
              </div>
              <button
                type="button"
                className="flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold hover:bg-zinc-50"
                style={{ color: ink }}
                onClick={() => onStepChange("details")}
                aria-label="Change mobile number"
              >
                <Pencil className="size-3.5" aria-hidden />
                Edit
              </button>
            </div>

            <section className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-4 py-3.5 text-left"
                aria-expanded={summaryOpen}
                aria-controls="checkout-order-lines"
                onClick={() => setSummaryOpen((open) => !open)}
              >
                <span className="min-w-0 flex-1 text-[15px] font-bold text-zinc-900">
                  Order summary <span className="text-xs font-medium text-zinc-500">({String(itemCount).padStart(2, "0")} {itemCount === 1 ? "item" : "items"})</span>
                </span>
                {totalSavings > 0 ? <s className="text-xs text-zinc-400 tabular-nums">{formatStorePrice(mrpTotal)}</s> : null}
                <span className="text-sm font-bold tabular-nums text-zinc-900">{formatStorePrice(total)}</span>
                <ChevronDown className={`size-4 text-zinc-500 transition-transform ${summaryOpen ? "rotate-180" : ""}`} aria-hidden />
              </button>
              {summaryOpen ? (
                <ul id="checkout-order-lines" className="space-y-3 border-t border-zinc-100 px-4 py-3">
                  {cart.map((line) => {
                    const compare = line.product.compareAtPrice && line.product.compareAtPrice > line.product.price ? line.product.compareAtPrice : null;
                    return (
                      <li key={line.product.id} className="flex gap-3">
                        <span className="relative size-14 shrink-0 overflow-hidden rounded-xl bg-zinc-100">
                          <StoreImage src={line.product.imageUrls[0]} alt="" sizes="56px" />
                          <span className="absolute right-0.5 top-0.5 flex min-w-5 items-center justify-center rounded-full bg-zinc-900/80 px-1 text-[10px] font-bold text-white">{line.quantity}</span>
                        </span>
                        <span className="min-w-0 flex-1 text-sm">
                          <span className="line-clamp-2 font-medium text-zinc-900">{line.product.name}</span>
                          {line.bundle ? <span className="block text-xs text-zinc-500">{line.bundle.components.map((item) => `${item.quantity} × ${item.product.name}`).join(" + ")}</span> : null}
                          <span className="block text-xs text-zinc-500">{returnPolicyLabel(line.product.returnAvailable !== false)}</span>
                        </span>
                        <span className="shrink-0 text-right text-sm">
                          <span className="block font-semibold tabular-nums">{formatStorePrice(line.product.price * line.quantity)}</span>
                          {compare ? <s className="block text-xs text-zinc-400 tabular-nums">{formatStorePrice(compare * line.quantity)}</s> : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {totalSavings > 0 ? (
                <p className="flex items-center justify-center gap-1.5 bg-emerald-50 px-4 py-2 text-xs font-semibold text-emerald-800" role="status">
                  <Sparkles className="size-3.5" aria-hidden />
                  Yay! You&apos;ve saved {formatStorePrice(totalSavings)} so far
                  <Sparkles className="size-3.5" aria-hidden />
                </p>
              ) : null}
            </section>

            {!preview && onCouponApply ? (
              <Card title="Coupons & offers" icon={<BadgePercent className="size-4" style={{ color: ink }} aria-hidden />}>
                <CouponField
                  coupon={quotedCoupon}
                  error={couponError}
                  pending={quote.isFetching}
                  accentColor={ink}
                  onApply={(code) => {
                    setCouponError(null);
                    trackApply.current = true;
                    onCouponApply(code);
                  }}
                  onRemove={() => {
                    setCouponError(null);
                    onCouponRemove?.(quotedCoupon?.automatic ?? false);
                  }}
                />
              </Card>
            ) : null}

            {visibleRecommendations.length ? (
              <section className="rounded-2xl border border-zinc-200/80 bg-white py-4">
                <h3 className="px-4 text-[15px] font-bold text-zinc-900">Items you may like</h3>
                <ul className="mt-3 flex snap-x gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {visibleRecommendations.map((product) => (
                    <li key={product.id} className="flex w-60 shrink-0 snap-start items-center gap-3 rounded-xl border border-zinc-100 p-2">
                      <span className="relative size-14 shrink-0 overflow-hidden rounded-lg bg-zinc-100">
                        <StoreImage src={product.imageUrls[0]} alt="" sizes="56px" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-zinc-800">{product.name}</span>
                        <span className="mt-0.5 block text-sm font-bold tabular-nums">
                          {product.compareAtPrice && product.compareAtPrice > product.price ? <s className="mr-1 text-xs font-normal text-zinc-400">{formatStorePrice(product.compareAtPrice)}</s> : null}
                          {formatStorePrice(product.price)}
                        </span>
                        <button
                          type="button"
                          className="mt-1 inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-bold"
                          style={{ borderColor: ink, color: ink }}
                          onClick={() => onAdd?.(product)}
                          aria-label={`Add ${product.name}`}
                        >
                          <Plus className="size-3" aria-hidden />
                          Add
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <Card title="Deliver to" icon={<Truck className="size-4" style={{ color: ink }} aria-hidden />}>
              <FastCheckoutDetails form={form} buyer={buyer} apiRef={apiRef} accent={accent} part="address" />
              <p className="mt-3 flex items-center gap-1.5 text-xs text-zinc-500">
                <MessageCircle className="size-3.5 shrink-0" aria-hidden />
                Shipped by India Post. Tracking updates on WhatsApp.
              </p>
            </Card>

            {prepaid || cod ? (
              <Card title="Payment method" icon={<Wallet className="size-4" style={{ color: ink }} aria-hidden />}>
                <div className="grid gap-2" role="radiogroup" aria-label="Payment method">
                  {prepaid ? (
                    <label
                      className="flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border bg-white px-3 py-2.5 text-sm transition"
                      style={preference === "PREPAID" ? { borderColor: ink, boxShadow: `0 0 0 1px ${ink}` } : { borderColor: "#e4e4e7" }}
                    >
                      <input type="radio" value="PREPAID" className="size-4 shrink-0" style={{ accentColor: ink }} {...form.register("paymentPreference")} />
                      <Wallet className="size-5 shrink-0 text-zinc-500" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-zinc-900">{onlinePayment ? "Pay online" : "Prepaid"}</span>
                        <span className="block text-xs text-zinc-500">
                          {onlinePayment ? `UPI, cards, net banking or wallets · secured by ${onlinePaymentProvider === "CASHFREE" ? "Cashfree" : "Razorpay"}` : "Pay the full amount in advance"}
                        </span>
                      </span>
                      <span className="shrink-0 font-bold tabular-nums">{formatStorePrice(preference === "PREPAID" ? total : productAmount - couponDiscount)}</span>
                    </label>
                  ) : null}
                  {cod ? (
                    <label
                      className="flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border bg-white px-3 py-2.5 text-sm transition"
                      style={preference === "COD" ? { borderColor: ink, boxShadow: `0 0 0 1px ${ink}` } : { borderColor: "#e4e4e7" }}
                    >
                      <input type="radio" value="COD" className="size-4 shrink-0" style={{ accentColor: ink }} {...form.register("paymentPreference")} />
                      <Banknote className="size-5 shrink-0 text-zinc-500" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-zinc-900">Cash on delivery</span>
                        <span className="block text-xs text-zinc-500">
                          {quote.data && preference === "COD" && quote.data.amountDueNow > 0
                            ? `Advance ${formatStorePrice(quote.data.amountDueNow)} · pay ${formatStorePrice(quote.data.amountOnDelivery)} on delivery`
                            : "Pay when your parcel arrives"}
                        </span>
                      </span>
                    </label>
                  ) : null}
                </div>
                {quote.data && preference === "COD" && quote.data.amountDueNow > 0 ? (
                  <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-medium text-amber-950">
                    An advance of {formatStorePrice(quote.data.amountDueNow)} is needed to confirm a COD order.
                    {onlinePayment ? " You'll pay it online right after placing the order." : ""}
                  </p>
                ) : null}
              </Card>
            ) : (
              <p className="rounded-2xl bg-red-50 p-3 text-sm text-red-700">These products cannot be ordered together. Remove prepaid-only or COD-only items.</p>
            )}

            <Card id="checkout-price-details" title="Price details">
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Item total{mrpSavings > 0 ? " (MRP)" : ""}</dt>
                  <dd className="tabular-nums">{formatStorePrice(mrpTotal)}</dd>
                </div>
                {mrpSavings > 0 ? (
                  <div className="flex justify-between gap-3 text-emerald-700">
                    <dt>Discount on MRP</dt>
                    <dd className="tabular-nums">−{formatStorePrice(mrpSavings)}</dd>
                  </div>
                ) : null}
                {quotedCoupon?.applied ? (
                  <div className="flex justify-between gap-3 text-emerald-700">
                    <dt>Coupon <span className="font-mono">{quotedCoupon.code}</span></dt>
                    <dd className="tabular-nums">−{formatStorePrice(quotedCoupon.discount)}</dd>
                  </div>
                ) : null}
                {preference === "COD" && codAdvance > 0 ? (
                  <>
                    <div className="flex justify-between gap-3">
                      <dt className="text-zinc-500">Advance to pay now</dt>
                      <dd className="tabular-nums">{formatStorePrice(codAdvance)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-zinc-500">Pay on delivery</dt>
                      <dd className="tabular-nums">{formatStorePrice(quote.data?.amountOnDelivery ?? total)}</dd>
                    </div>
                  </>
                ) : null}
                <div className="flex justify-between gap-3 border-t border-dashed border-zinc-200 pt-2.5 text-base font-bold text-zinc-900">
                  <dt>Total</dt>
                  <dd className="tabular-nums">{formatStorePrice(total)}</dd>
                </div>
              </dl>
            </Card>

            <Card>
              <p className="flex items-start gap-2 text-sm text-zinc-700">
                <RotateCcw className="mt-0.5 size-4 shrink-0 text-zinc-500" aria-hidden />
                <span>{returns.label}</span>
              </p>
              {returns.kind === "mixed" ? (
                <ul className="mt-2 space-y-1 pl-6 text-xs text-zinc-500">
                  {cart.map((line) => (
                    <li key={line.product.id} className="flex justify-between gap-2">
                      <span className="min-w-0 truncate">{line.product.name}</span>
                      <span className="shrink-0">{returnPolicyLabel(line.product.returnAvailable !== false)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>

            {error ? (
              <div role="alert" className="rounded-2xl bg-red-50 p-3 text-sm text-red-700">
                {error}
              </div>
            ) : null}

            <div className="py-3">
              <TrustRow />
            </div>
          </div>
        )}
      </div>

      <div className="mt-auto shrink-0 border-t border-zinc-200 bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-4px_16px_rgba(0,0,0,0.04)]">
        <div className="mx-auto max-w-lg">
          {step === "summary" && rootError ? <p role="alert" className="mb-2 text-sm text-red-600">{rootError}</p> : null}
          {step === "details" ? (
            <>
              <button
                type="submit"
                className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl text-sm font-bold transition hover:brightness-95 disabled:bg-zinc-200 disabled:text-zinc-500"
                style={buyer.status === "checking" || buyer.sendCode.isPending ? undefined : onAccent(accent)}
                disabled={!cart.length || buyer.status === "checking" || buyer.sendCode.isPending}
              >
                {buyer.status === "checking" || buyer.sendCode.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {buyer.needsVerification ? (buyer.codeSentTo ? "Enter the code to continue" : "Send WhatsApp code") : "Continue"}
              </button>
              <p className="mt-2 flex items-center justify-center gap-1 text-[11px] text-zinc-500">
                <Lock className="size-3" aria-hidden />
                Your details are only shared with this store for delivery.
              </p>
            </>
          ) : (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-lg font-bold leading-6 tabular-nums text-zinc-900">{formatStorePrice(total)}</p>
                <button
                  type="button"
                  className="text-xs font-semibold underline underline-offset-2"
                  style={{ color: ink }}
                  onClick={() => document.getElementById("checkout-price-details")?.scrollIntoView({ behavior: "smooth", block: "center" })}
                >
                  View price details
                </button>
              </div>
              <button
                type="submit"
                className="flex h-12 min-w-40 items-center justify-center gap-2 rounded-2xl px-6 text-sm font-bold transition hover:brightness-95 disabled:bg-zinc-200 disabled:text-zinc-500"
                style={submitting || !cart.length ? undefined : onAccent(accent)}
                disabled={submitting || !cart.length || preview || quote.isFetching || quote.isError || !quote.data || (!prepaid && !cod)}
              >
                {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Lock className="size-4" aria-hidden />}
                {submitting
                  ? "Placing order…"
                  : onlinePayment && quote.data && quote.data.amountDueNow > 0
                    ? `Pay ${formatStorePrice(quote.data.amountDueNow)}`
                    : "Place order"}
              </button>
            </div>
          )}
        </div>
      </div>
    </form>
  );
}
