"use client";

import { useId, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { commitEmailDraft } from "@/modules/manifest-email/recipients";
import { cn } from "@/lib/utils";

function sameList(left: string[], right: string[]) {
  return left.length === right.length && left.every((email, index) => email === right[index]);
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
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const statusId = useId();
  const [pending, setPending] = useState("");
  const [error, setError] = useState<string | null>(null);

  function apply(draft: string, flushPending: boolean) {
    const result = commitEmailDraft(emails, draft, { max, flushPending });
    setPending(result.pending);
    setError(result.error);
    if (!sameList(result.emails, emails)) onChange(result.emails);
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={inputId}>{label}</Label>
        <p id={statusId} className="text-xs text-muted" role="status">
          {emails.length} of {max} addresses
        </p>
      </div>
      <div
        className={cn(
          "rounded-[var(--radius-input)] border border-border bg-card p-2 shadow-sm focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/30",
          error && "border-error focus-within:ring-error/25"
        )}
      >
        {emails.length ? (
          <ul className="mb-2 flex flex-wrap gap-2">
            {emails.map((email) => (
              <li key={email} className="flex max-w-full items-center rounded-full border border-border bg-surface-soft">
                <span className="whitespace-nowrap px-3 text-sm">{email}</span>
                <Button
                  type="button"
                  variant="ghost"
                  className="size-11 shrink-0 rounded-full"
                  disabled={disabled}
                  aria-label={`Remove ${email}`}
                  onClick={() => onChange(emails.filter((item) => item !== email))}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <input
          id={inputId}
          type="text"
          inputMode="email"
          autoComplete="email"
          value={pending}
          disabled={disabled}
          placeholder={emails.length ? "Add another address" : "office@example.com, ops@example.com"}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          className="h-11 w-full bg-transparent px-2 text-sm text-foreground outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed disabled:opacity-50"
          onChange={(event) => apply(event.target.value, false)}
          onBlur={(event) => apply(event.currentTarget.value, true)}
          onKeyDown={(event) => {
            const value = event.currentTarget.value;
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              apply(event.key === "," ? `${value},` : value, event.key === "Enter");
            } else if (event.key === "Backspace" && !value && emails.length) {
              onChange(emails.slice(0, -1));
            }
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");
            if (!/[,;\s]/.test(pasted)) return;
            event.preventDefault();
            apply(`${event.currentTarget.value}${pasted}`, true);
          }}
        />
      </div>
      <p id={hintId} className="text-xs text-muted">
        Type an address and press Enter, or paste several separated by commas.
      </p>
      <p id={errorId} role={error ? "alert" : undefined} className="min-h-5 text-sm text-error">
        {error ?? ""}
      </p>
    </div>
  );
}
