"use client";

import { useId, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isIndiaWhatsappInput, toIndiaWhatsappE164 } from "@/lib/phone/india-whatsapp";
import { cn } from "@/lib/utils";

export type WhatsAppRecipientDraft = {
  e164: string;
  name: string | null;
};

function addRecipient(list: WhatsAppRecipientDraft[], phone: string, name: string) {
  if (!isIndiaWhatsappInput(phone)) {
    return { list, error: "Enter a 10-digit Indian WhatsApp number." };
  }
  const e164 = toIndiaWhatsappE164(phone);
  if (list.some((item) => item.e164 === e164)) {
    return { list, error: "That WhatsApp number is already on the list." };
  }
  return {
    list: [...list, { e164, name: name.trim().slice(0, 80) || null }],
    error: null as string | null,
  };
}

export function WhatsAppRecipientList({
  label,
  recipients,
  disabled,
  max,
  onChange,
}: {
  label: string;
  recipients: WhatsAppRecipientDraft[];
  disabled: boolean;
  max: number;
  onChange: (next: WhatsAppRecipientDraft[]) => void;
}) {
  const phoneId = useId();
  const nameId = useId();
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  function add() {
    if (recipients.length >= max) {
      setError(`Save at most ${max} WhatsApp numbers.`);
      return;
    }
    const result = addRecipient(recipients, phone, name);
    setError(result.error);
    if (!result.error) {
      onChange(result.list);
      setPhone("");
      setName("");
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={phoneId}>{label}</Label>
        <p className="text-xs text-muted" role="status">
          {recipients.length} of {max} numbers
        </p>
      </div>
      <div
        className={cn(
          "grid gap-2 rounded-[var(--radius-input)] border border-border bg-card p-2 shadow-sm",
          error && "border-error"
        )}
      >
        {recipients.length ? (
          <ul className="flex flex-wrap gap-2">
            {recipients.map((item) => (
              <li key={item.e164} className="flex max-w-full items-center rounded-full border border-border bg-surface-soft">
                <span className="whitespace-nowrap px-3 text-sm">
                  {item.name ? `${item.name} · ${item.e164}` : item.e164}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  className="size-11 shrink-0 rounded-full"
                  disabled={disabled}
                  aria-label={`Remove ${item.e164}`}
                  onClick={() => onChange(recipients.filter((row) => row.e164 !== item.e164))}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input
            id={nameId}
            value={name}
            disabled={disabled}
            placeholder="Recipient name"
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            id={phoneId}
            inputMode="tel"
            value={phone}
            disabled={disabled}
            placeholder="10-digit Indian mobile"
            onChange={(event) => setPhone(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
          />
          <Button type="button" variant="secondary" disabled={disabled} onClick={add}>
            Add
          </Button>
        </div>
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
