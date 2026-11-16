"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function EmailList({
  label,
  emails,
  disabled,
  max,
  onChange,
}: {
  label: string;
  emails: string[];
  disabled: boolean;
  max: number;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const normalized = draft.trim().toLowerCase();
  const duplicate = Boolean(normalized) && emails.includes(normalized);
  const invalid = Boolean(normalized) && !looksLikeEmail(normalized);

  function add() {
    if (!normalized || invalid || duplicate || emails.length >= max) return;
    onChange([...emails, normalized]);
    setDraft("");
  }

  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <ul className="grid gap-2">
        {emails.map((email) => (
          <li key={email} className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm">{email}</span>
            <Button
              type="button"
              variant="secondary"
              className="h-8 px-2"
              disabled={disabled}
              aria-label={`Remove ${email}`}
              onClick={() => onChange(emails.filter((item) => item !== email))}
            >
              <X className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="email"
          value={draft}
          disabled={disabled || emails.length >= max}
          placeholder="office@example.com"
          aria-label={label}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button type="button" variant="secondary" disabled={disabled || !normalized || invalid || duplicate || emails.length >= max} onClick={add}>
          <Plus className="size-4" />
          Add email address
        </Button>
      </div>
      {duplicate ? <p className="text-sm text-amber-700">That address is already in the list.</p> : null}
      {invalid ? <p className="text-sm text-red-700">Enter a valid email address.</p> : null}
      <p className="text-xs text-muted">
        {emails.length} of {max}
      </p>
    </div>
  );
}
