"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Controller, useWatch, type UseFormReturn } from "react-hook-form";
import { z } from "zod";
import { IndiaWhatsappField } from "@/components/auth/india-whatsapp-field";
import { StorePincodeLookup } from "@/components/storefront/store-pincode-lookup";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/hooks/use-api";
import { INDIAN_STATE_OPTIONS } from "@/lib/indian-states";
import { extractIndiaMobileDigits } from "@/lib/phone/india-whatsapp";
import { onAccent, readableAccent } from "@/modules/storefront/config";

export const checkoutSchema = z.object({
  customerName: z.string().trim().min(2, "Enter your full name."),
  phone: z.string().trim().refine((value) => extractIndiaMobileDigits(value) !== null, "Enter a valid 10-digit mobile number."),
  line1: z.string().trim().min(3, "Enter your delivery address."),
  line2: z.string().trim().optional(),
  city: z.string().trim().min(2, "Enter your city."),
  state: z.string().trim().min(2, "Select your state."),
  pincode: z.string().trim().regex(/^\d{6}$/, "Enter a valid 6-digit PIN code."),
  paymentPreference: z.enum(["PREPAID", "COD"]).optional(),
  saveAddress: z.boolean().optional(),
});

export type CheckoutValues = z.infer<typeof checkoutSchema> & { quoteVersion?: string };
type StoreRef = { workspace?: string; publicId?: string; token?: string };
type SavedAddress = { id: string; customerName: string; line1: string; line2: string | null; city: string; state: string; pincode: string };
type Lookup = { status: "new" } | { status: "verify" } | { status: "ready"; addresses: SavedAddress[] };

const phoneKey = (workspace: string) => `postbus-buyer-phone:${workspace}`;

/** The number this browser last checked out with, so a returning buyer types nothing. */
export function rememberedBuyerPhone(workspace: string) {
  try {
    return localStorage.getItem(phoneKey(workspace)) ?? "";
  } catch {
    return "";
  }
}

export function rememberBuyerPhone(workspace: string, phone: string | null) {
  try {
    if (phone) localStorage.setItem(phoneKey(workspace), phone);
    else localStorage.removeItem(phoneKey(workspace));
  } catch {
    /* storage can be unavailable in private modes */
  }
}

function checkoutCall<T>(apiRef: StoreRef, body: Record<string, unknown>) {
  return api<T>("/api/v1/public/store/checkout", {
    method: "POST",
    body: JSON.stringify({ workspace: apiRef.workspace, code: apiRef.publicId, token: apiRef.token, ...body }),
  });
}

const ADDRESS_FIELDS = ["line1", "line2", "city", "pincode"] as const;

/**
 * Phone-first checkout state. A known browser gets saved addresses at once; a new
 * browser proves the number with a WhatsApp code; an unknown number types everything.
 */
export function useFastCheckout({ form, apiRef, preview, workspace }: { form: UseFormReturn<CheckoutValues>; apiRef: StoreRef; preview: boolean; workspace: string }) {
  const queryClient = useQueryClient();
  const phoneValue = useWatch({ control: form.control, name: "phone" });
  const phone = extractIndiaMobileDigits(phoneValue ?? "") ?? "";
  const lookupKey = ["store-buyer", workspace, phone] as const;
  const lookup = useQuery({
    queryKey: lookupKey,
    enabled: !preview && phone.length === 10,
    queryFn: () => checkoutCall<Lookup>(apiRef, { action: "lookup", phone }),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const [manualFor, setManualFor] = useState<string | null>(null);
  const [chosen, setChosen] = useState<{ phone: string; id: string } | null>(null);
  const [codeSent, setCodeSent] = useState<{ phone: string; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const status: "idle" | "checking" | Lookup["status"] = !phone || preview
    ? "idle"
    : lookup.isPending
      ? "checking"
      : lookup.isError || !lookup.data
        ? "new"
        : lookup.data.status;
  const addresses = status === "ready" && lookup.data?.status === "ready" ? lookup.data.addresses : [];
  const manual = status === "idle" || status === "new" || manualFor === phone || (status === "ready" && !addresses.length);
  const selected = !manual ? (addresses.find((item) => chosen?.phone === phone && item.id === chosen.id) ?? addresses[0] ?? null) : null;
  const needsVerification = status === "verify" && manualFor !== phone;

  // Copy the chosen saved address into the form so validation and submit work unchanged.
  const appliedFor = useRef<string | null>(null);
  useEffect(() => {
    if (selected) {
      form.setValue("customerName", selected.customerName, { shouldValidate: true });
      form.setValue("line1", selected.line1, { shouldValidate: true });
      form.setValue("line2", selected.line2 ?? "");
      form.setValue("city", selected.city, { shouldValidate: true });
      form.setValue("state", selected.state, { shouldValidate: true });
      form.setValue("pincode", selected.pincode, { shouldValidate: true });
      form.setValue("saveAddress", true);
      appliedFor.current = phone;
    } else if (appliedFor.current && appliedFor.current !== phone) {
      // A different number must not inherit the previous buyer's name or address.
      for (const field of ADDRESS_FIELDS) form.setValue(field, "");
      form.setValue("customerName", "");
      appliedFor.current = null;
    }
  }, [form, phone, selected]);

  useEffect(() => {
    if (!codeSent) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [codeSent]);

  const sendCode = useMutation({
    mutationFn: () => checkoutCall<{ sent: true; resendInSeconds: number }>(apiRef, { action: "send-code", phone }),
    onSuccess: () => {
      setCodeSent({ phone, at: Date.now() });
      setNow(Date.now());
      requestAnimationFrame(() => document.getElementById("fast-checkout-code")?.focus());
    },
  });
  const verifyCode = useMutation({
    mutationFn: (otp: string) => checkoutCall<Lookup>(apiRef, { action: "verify-code", phone, otp }),
    onSuccess: (data) => {
      queryClient.setQueryData(lookupKey, data);
      setCodeSent(null);
    },
  });
  const forget = useMutation({
    mutationFn: (addressId: string) => checkoutCall<{ addresses: SavedAddress[] }>(apiRef, { action: "forget-address", phone, addressId }),
    onSuccess: (data) => {
      queryClient.setQueryData(lookupKey, data.addresses.length ? { status: "ready", addresses: data.addresses } : { status: "new" });
      if (!data.addresses.length) for (const field of ADDRESS_FIELDS) form.setValue(field, "");
    },
  });

  const enterManually = useCallback(() => {
    setManualFor(phone);
    for (const field of ADDRESS_FIELDS) form.setValue(field, "");
    form.setValue("saveAddress", true);
    appliedFor.current = null;
    requestAnimationFrame(() => document.getElementById(status === "ready" ? "delivery-address" : "customer-name")?.focus());
  }, [form, phone, status]);

  const chooseSaved = useCallback((id: string) => {
    setManualFor(null);
    setChosen({ phone, id });
  }, [phone]);

  const resendIn = codeSent?.phone === phone ? Math.max(0, 60 - Math.floor((now - codeSent.at) / 1000)) : 0;

  return {
    phone,
    status,
    addresses,
    manual,
    selected,
    needsVerification,
    codeSentTo: codeSent?.phone === phone ? phone : null,
    resendIn,
    sendCode,
    verifyCode,
    forget,
    enterManually,
    chooseSaved,
    /** The main checkout button while a code is needed: send one, or go to the code box. */
    continueVerification: () => {
      if (codeSent?.phone === phone) document.getElementById("fast-checkout-code")?.focus();
      else if (!sendCode.isPending) sendCode.mutate();
    },
  };
}

export type FastCheckout = ReturnType<typeof useFastCheckout>;

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <p id={id} className="mt-1 text-xs text-red-600">{message}</p> : null;
}

function invalidProps(id: string, message?: string) {
  return message ? { "aria-invalid": true as const, "aria-describedby": id } : {};
}

function formatAddress(address: SavedAddress) {
  return [address.line1, address.line2, `${address.city}, ${address.state} ${address.pincode}`].filter(Boolean).join(", ");
}

export function FastCheckoutDetails({
  form,
  buyer,
  apiRef,
  accent,
  onPhoneReset,
}: {
  form: UseFormReturn<CheckoutValues>;
  buyer: FastCheckout;
  apiRef: StoreRef;
  accent: string;
  onPhoneReset: () => void;
}) {
  const errors = form.formState.errors;
  const pincode = useWatch({ control: form.control, name: "pincode" });
  const ink = readableAccent(accent);
  const resolvePincode = useCallback(
    (city: string, state: string) => {
      if (city && form.getValues("city").trim() !== city) form.setValue("city", city, { shouldDirty: true, shouldValidate: true });
      if (state && form.getValues("state") !== state) form.setValue("state", state, { shouldDirty: true, shouldValidate: true });
    },
    [form]
  );
  const [otp, setOtp] = useState("");
  const verifyError = buyer.verifyCode.error?.message ?? buyer.sendCode.error?.message ?? null;

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <IndiaWhatsappField control={form.control} name="phone" id="customer-phone" error={errors.phone?.message} />
        <div className="min-h-5 text-xs" aria-live="polite">
          {buyer.status === "checking" ? (
            <span className="inline-flex items-center gap-1.5 text-zinc-500"><Loader2 className="size-3.5 animate-spin" aria-hidden />Checking for saved details…</span>
          ) : buyer.status === "ready" && buyer.addresses.length ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700"><Check className="size-3.5" aria-hidden />Welcome back. Your saved address is ready.</span>
          ) : buyer.phone ? (
            <span className="text-zinc-500">Order updates are sent to this WhatsApp number.</span>
          ) : (
            <span className="text-zinc-500">Ordered before? Enter the same number to use your saved address.</span>
          )}
          {buyer.phone ? (
            <button type="button" className="ml-2 font-semibold text-zinc-600 underline underline-offset-2" onClick={onPhoneReset}>
              Use a different number
            </button>
          ) : null}
        </div>
      </section>

      {buyer.needsVerification ? (
        <section className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4" aria-labelledby="fast-checkout-verify">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white ring-1 ring-zinc-200">
              <ShieldCheck className="size-4" style={{ color: ink }} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h3 id="fast-checkout-verify" className="text-sm font-semibold text-zinc-900">You have a saved address with this store</h3>
              <p className="mt-0.5 text-sm text-zinc-600">
                {buyer.codeSentTo
                  ? `Enter the 6-digit code we sent on WhatsApp to +91 ••••••${buyer.phone.slice(-4)}.`
                  : "Confirm it's your number with a WhatsApp code, and we'll fill in your address."}
              </p>
            </div>
          </div>
          {buyer.codeSentTo ? (
            <div className="mt-3">
              <Label htmlFor="fast-checkout-code">WhatsApp code</Label>
              <div className="mt-1 flex gap-2">
                <Input
                  id="fast-checkout-code"
                  className="h-11 flex-1 text-center text-lg font-semibold tracking-[0.4em] tabular-nums"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={otp}
                  aria-invalid={buyer.verifyCode.isError || undefined}
                  aria-describedby={verifyError ? "fast-checkout-error" : undefined}
                  onChange={(event) => {
                    const next = event.target.value.replace(/\D/g, "").slice(0, 6);
                    setOtp(next);
                    if (next.length === 6 && !buyer.verifyCode.isPending) buyer.verifyCode.mutate(next);
                  }}
                />
                <button
                  type="button"
                  className="h-11 shrink-0 rounded-xl px-4 text-sm font-bold disabled:opacity-50"
                  style={onAccent(accent)}
                  disabled={otp.length !== 6 || buyer.verifyCode.isPending}
                  onClick={() => buyer.verifyCode.mutate(otp)}
                >
                  {buyer.verifyCode.isPending ? <Loader2 className="size-4 animate-spin" aria-label="Checking code" /> : "Confirm"}
                </button>
              </div>
              <button
                type="button"
                className="mt-2 text-xs font-semibold text-zinc-600 underline underline-offset-2 disabled:no-underline disabled:opacity-60"
                disabled={buyer.resendIn > 0 || buyer.sendCode.isPending}
                onClick={() => { setOtp(""); buyer.sendCode.mutate(); }}
              >
                {buyer.resendIn > 0 ? `Resend code in ${buyer.resendIn}s` : "Resend code"}
              </button>
            </div>
          ) : (
            <button
              id="fast-checkout-send"
              type="button"
              className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-bold disabled:opacity-60"
              style={onAccent(accent)}
              disabled={buyer.sendCode.isPending}
              onClick={() => buyer.sendCode.mutate()}
            >
              {buyer.sendCode.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Send code on WhatsApp
            </button>
          )}
          {verifyError ? <p id="fast-checkout-error" role="alert" className="mt-2 text-sm text-red-600">{verifyError}</p> : null}
          <button type="button" className="mt-3 w-full text-center text-sm font-semibold text-zinc-600 underline underline-offset-2" onClick={buyer.enterManually}>
            Enter address instead
          </button>
        </section>
      ) : null}

      {buyer.status === "ready" && buyer.addresses.length ? (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-semibold text-zinc-900">Deliver to</legend>
          {buyer.addresses.map((address) => {
            const active = !buyer.manual && buyer.selected?.id === address.id;
            return (
              <div
                key={address.id}
                className="relative flex items-start gap-3 rounded-2xl border bg-white p-3 transition"
                style={active ? { borderColor: ink, boxShadow: `0 0 0 1px ${ink}` } : { borderColor: "#e4e4e7" }}
              >
                <input
                  id={`saved-${address.id}`}
                  type="radio"
                  name="saved-address"
                  className="mt-1 size-4 shrink-0"
                  style={{ accentColor: ink }}
                  checked={active}
                  onChange={() => buyer.chooseSaved(address.id)}
                />
                <label htmlFor={`saved-${address.id}`} className="min-w-0 flex-1 cursor-pointer text-sm after:absolute after:inset-0">
                  <span className="block font-semibold text-zinc-900">{address.customerName}</span>
                  <span className="mt-0.5 block leading-5 text-zinc-600">{formatAddress(address)}</span>
                </label>
                <button
                  type="button"
                  className="relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-red-600 disabled:opacity-50"
                  aria-label={`Remove saved address ${address.line1}`}
                  disabled={buyer.forget.isPending}
                  onClick={() => buyer.forget.mutate(address.id)}
                >
                  <Trash2 className="size-4" aria-hidden />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="flex min-h-12 w-full items-center gap-3 rounded-2xl border border-dashed px-3 text-left text-sm font-semibold transition hover:bg-zinc-50"
            style={buyer.manual ? { borderColor: ink, color: ink } : { borderColor: "#d4d4d8", color: "#3f3f46" }}
            aria-pressed={buyer.manual}
            onClick={buyer.enterManually}
          >
            <Plus className="size-4" aria-hidden />
            Deliver to a new address
          </button>
          {buyer.forget.error ? <p role="alert" className="text-sm text-red-600">{buyer.forget.error.message}</p> : null}
        </fieldset>
      ) : null}

      {buyer.manual ? (
        <section className="space-y-3" aria-label="Delivery address">
          <div>
            <Label htmlFor="customer-name">Full name</Label>
            <Input id="customer-name" className="mt-1 h-11" autoComplete="name" {...invalidProps("customer-name-error", errors.customerName?.message)} {...form.register("customerName")} />
            <FieldError id="customer-name-error" message={errors.customerName?.message} />
          </div>
          <div>
            <Label htmlFor="delivery-address">House, building, street</Label>
            <Input id="delivery-address" className="mt-1 h-11" autoComplete="address-line1" {...invalidProps("delivery-address-error", errors.line1?.message)} {...form.register("line1")} />
            <FieldError id="delivery-address-error" message={errors.line1?.message} />
          </div>
          <div>
            <Label htmlFor="delivery-area">Area / locality <span className="font-normal text-zinc-500">(optional)</span></Label>
            <Input id="delivery-area" className="mt-1 h-11" autoComplete="address-line2" {...form.register("line2")} />
          </div>
          <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">
            <div>
              <Label htmlFor="delivery-pincode">PIN code</Label>
              <Input id="delivery-pincode" className="mt-1 h-11" inputMode="numeric" autoComplete="postal-code" maxLength={6} {...invalidProps("delivery-pincode-error", errors.pincode?.message)} {...form.register("pincode")} />
              <FieldError id="delivery-pincode-error" message={errors.pincode?.message} />
            </div>
            <div>
              <Label htmlFor="delivery-city">City</Label>
              <Input id="delivery-city" className="mt-1 h-11" autoComplete="address-level2" {...invalidProps("delivery-city-error", errors.city?.message)} {...form.register("city")} />
              <FieldError id="delivery-city-error" message={errors.city?.message} />
            </div>
          </div>
          <StorePincodeLookup linkRef={apiRef} pincode={pincode} onResolve={resolvePincode} />
          <div>
            <Label htmlFor="delivery-state">State</Label>
            <Controller
              control={form.control}
              name="state"
              render={({ field }) => <Combobox id="delivery-state" className="mt-1" options={INDIAN_STATE_OPTIONS} value={field.value} onChange={field.onChange} />}
            />
            <FieldError id="delivery-state-error" message={errors.state?.message} />
          </div>
          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl bg-zinc-50 px-3 py-2.5 text-sm">
            <input type="checkbox" className="mt-0.5 size-4 shrink-0" style={{ accentColor: ink }} {...form.register("saveAddress")} />
            <span>
              <span className="block font-semibold text-zinc-900">Save this address for next time</span>
              <span className="block text-xs leading-5 text-zinc-500">Next order, just enter your WhatsApp number. New devices confirm with a WhatsApp code.</span>
            </span>
          </label>
        </section>
      ) : null}

    </div>
  );
}
