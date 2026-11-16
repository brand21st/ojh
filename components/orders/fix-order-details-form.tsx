"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Loader2 } from "lucide-react";
import { IndiaMobileInput } from "@/components/auth/india-whatsapp-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { extractIndiaMobileDigits, indiaMobileInputDigits } from "@/lib/phone/india-whatsapp";
import { cn } from "@/lib/utils";

export type SavePhase = "idle" | "saving" | "success";

const PHONE_MESSAGE = "Enter a valid 10-digit mobile number.";
const PIN_MESSAGE = "Enter a valid 6-digit PIN code.";

export function FixOrderDetailsForm({
  orderNumber,
  customerName,
  showPhone,
  showPin,
  stateChoice,
  pinUnavailable,
  orderHref,
  initialPhone,
  initialPin,
  phoneError: phoneErrorProp = "",
  pinError: pinErrorProp = "",
  formError,
  phase,
  onSave,
}: {
  orderNumber: string;
  customerName: string;
  showPhone: boolean;
  showPin: boolean;
  stateChoice: boolean;
  pinUnavailable: boolean;
  orderHref: string;
  initialPhone: string;
  initialPin: string;
  phoneError?: string;
  pinError?: string;
  formError?: string;
  phase: SavePhase;
  onSave: (phone: string, pincode: string) => void;
}) {
  const [phone, setPhone] = useState(() => indiaMobileInputDigits(initialPhone));
  const [pincode, setPincode] = useState(initialPin);
  const [phoneError, setPhoneError] = useState(phoneErrorProp);
  const [pinError, setPinError] = useState(pinErrorProp);
  const canSave = (showPhone || showPin) && phase === "idle";

  function submit() {
    const nextPhoneError = showPhone && !extractIndiaMobileDigits(phone) ? PHONE_MESSAGE : "";
    const nextPinError = showPin && !/^[1-9][0-9]{5}$/.test(pincode) ? PIN_MESSAGE : "";
    setPhoneError(nextPhoneError);
    setPinError(nextPinError);
    if (nextPhoneError || nextPinError) return;
    onSave(phone, pincode);
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium text-ink">Order #{orderNumber}</p>
        <p className="truncate text-sm text-muted-foreground" title={customerName || "Customer"}>
          Customer: {customerName || "Customer"}
        </p>
      </div>
      {showPhone ? (
        <div className="space-y-1.5">
          <Label htmlFor="fix-mobile" className="text-sm text-error">
            Invalid Mobile Number
          </Label>
          <IndiaMobileInput
            id="fix-mobile"
            value={phone}
            autoFocus
            error={Boolean(phoneError)}
            describedBy={phoneError ? "fix-mobile-error" : undefined}
            placeholder="10-digit mobile"
            onChange={(value) => {
              setPhone(value);
              setPhoneError("");
            }}
          />
          {phoneError ? (
            <p id="fix-mobile-error" className="text-xs text-error">
              {phoneError}
            </p>
          ) : null}
        </div>
      ) : null}
      {showPin ? (
        <div className="space-y-1.5">
          <Label htmlFor="fix-pin" className="text-sm text-error">
            Invalid PIN Code
          </Label>
          <Input
            id="fix-pin"
            value={pincode}
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={6}
            autoFocus={!showPhone}
            aria-invalid={Boolean(pinError)}
            aria-describedby={pinError ? "fix-pin-error" : undefined}
            className="w-full"
            onChange={(event) => {
              setPincode(event.target.value.replace(/\D/g, "").slice(0, 6));
              setPinError("");
            }}
          />
          {pinError ? (
            <p id="fix-pin-error" className="text-xs text-error">
              {pinError}
            </p>
          ) : null}
        </div>
      ) : null}
      {stateChoice ? (
        <p className="text-sm text-muted-foreground">
          This PIN is used in more than one state.{" "}
          <Link href={orderHref} className="font-medium text-brand underline-offset-4 hover:underline">
            Open the full address editor
          </Link>{" "}
          to choose the state.
        </p>
      ) : null}
      {pinUnavailable ? (
        <p className="text-sm text-muted-foreground" role="status">
          India Post PIN check is temporarily unavailable. The PIN was not marked invalid. Try again shortly.
        </p>
      ) : null}
      {formError ? (
        <p className="text-sm text-error" role="alert">
          {formError}
        </p>
      ) : null}
      {canSave || phase !== "idle" ? (
        <Button
          type="button"
          className={cn(
            "w-full transition-colors duration-300",
            phase === "success" && "bg-emerald-600 text-white hover:bg-emerald-600 disabled:opacity-100"
          )}
          disabled={!canSave}
          aria-live="polite"
          onClick={submit}
        >
          {phase === "saving" ? (
            <>
              <Loader2 className="motion-safe:animate-spin" aria-hidden />
              Saving...
            </>
          ) : null}
          {phase === "success" ? (
            <>
              <Check aria-hidden className="text-white motion-safe:animate-[saved-pop_300ms_ease-out]" />
              Saved Successfully
            </>
          ) : null}
          {phase === "idle" ? "Save Changes" : null}
        </Button>
      ) : null}
      <style>{`@keyframes saved-pop{from{transform:scale(.8);opacity:.7}to{transform:scale(1);opacity:1}}`}</style>
    </div>
  );
}
