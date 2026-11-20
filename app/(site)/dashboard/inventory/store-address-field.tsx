"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/hooks/use-api";
import { cn } from "@/lib/utils";

type Availability = { slug: string; available: boolean; reason: string | null };

export function useDebounced<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

/** Turns "My Shop!" into "my-shop" as the merchant types; the server re-validates. */
export function toStoreAddress(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 48);
}

/** `https://{slug}.postbus.in` from the current subdomain URL, so the preview follows the draft slug. */
export function subdomainUrlFor(currentUrl: string, current: string, next: string) {
  try {
    const url = new URL(currentUrl);
    if (url.hostname.startsWith(`${current}.`)) {
      url.hostname = `${next}${url.hostname.slice(current.length)}`;
      return url.origin;
    }
  } catch {
    /* fall through */
  }
  return currentUrl;
}

export function StoreAddressField<T>({
  workspace,
  storeUrl,
  subdomainUrl,
  hostSuffix,
  subdomainsEnabled,
  canChange,
  onSaved,
}: {
  workspace: string;
  storeUrl: string;
  /** Always `https://{slug}.postbus.in`, even before subdomains are switched on. */
  subdomainUrl?: string;
  /** `.postbus.in` */
  hostSuffix?: string;
  subdomainsEnabled?: boolean;
  canChange: boolean;
  onSaved: (settings: T) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const value = draft ?? workspace;
  const slug = value.replace(/-+$/, "");
  const changed = slug !== workspace;
  const checkSlug = useDebounced(slug, 350);
  const availability = useQuery({
    queryKey: ["storefront-address", checkSlug],
    enabled: canChange && changed && checkSlug === slug && slug.length > 0,
    retry: false,
    staleTime: 10_000,
    queryFn: ({ signal }) => api<Availability>(`/api/v1/inventory/storefront/address?slug=${encodeURIComponent(checkSlug)}`, { signal }),
  });
  const save = useMutation({
    mutationFn: () => api<T>("/api/v1/inventory/storefront/address", { method: "PATCH", body: JSON.stringify({ slug }) }),
    onSuccess: (data) => {
      onSaved(data);
      setDraft(null);
      setConfirming(false);
      toast.success("Store address updated.");
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const suffix = hostSuffix || ".postbus.in";
  const hostUrl = subdomainUrl || storeUrl;
  const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const nextUrl = subdomainUrl ? subdomainUrlFor(subdomainUrl, workspace, slug) : storeUrl;
  const checking = changed && (checkSlug !== slug || availability.isFetching);
  const ready = changed && !checking && availability.data?.slug === slug && availability.data.available;
  const invalid = changed && !checking && availability.data?.slug === slug && !availability.data.available;

  function copy() {
    void navigator.clipboard
      .writeText(storeUrl)
      .then(() => toast.success("Store URL copied."))
      .catch(() => toast.error("Could not copy the URL."));
  }

  return (
    <div className="min-w-0">
      <Label htmlFor="store-address">Store address</Label>
      <div
        className={cn(
          "mt-1 flex h-11 min-w-0 items-center overflow-hidden rounded-md border bg-card focus-within:ring-2",
          invalid ? "border-red-500 focus-within:ring-red-500/30" : "border-border focus-within:border-brand focus-within:ring-brand/30"
        )}
      >
        <span className="shrink-0 pl-3 text-xs text-muted" aria-hidden>https://</span>
        <input
          id="store-address"
          className="h-full min-w-0 flex-1 bg-transparent text-right text-xs font-medium disabled:opacity-60"
          // The wrapper shows the focus ring; the global unlayered :focus-visible outline would draw a second one.
          style={{ outline: "none" }}
          value={value}
          maxLength={48}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="url"
          disabled={!canChange || save.isPending}
          aria-invalid={invalid || undefined}
          aria-describedby="store-address-hint"
          onChange={(event) => setDraft(toStoreAddress(event.target.value))}
          onKeyDown={(event) => {
            if (event.key === "Escape") setDraft(null);
            if (event.key === "Enter" && ready) setConfirming(true);
          }}
        />
        <span className="shrink-0 pr-3 text-xs text-muted">{suffix}</span>
      </div>
      <div id="store-address-hint" className="mt-1 flex min-h-5 items-center justify-between gap-2 text-xs" aria-live="polite">
        {!canChange ? (
          <span className="text-muted">Only owners and admins can change the address.</span>
        ) : !changed ? (
          <span className="text-muted">3–48 lowercase letters, numbers and hyphens.</span>
        ) : checking ? (
          <span className="flex items-center gap-1 text-muted"><Loader2 className="size-3 animate-spin" />Checking…</span>
        ) : availability.isError ? (
          <span className="text-red-600">{availability.error instanceof Error ? availability.error.message : "Could not check this address."}</span>
        ) : availability.data?.available ? (
          <span className="flex items-center gap-1 text-emerald-600"><Check className="size-3" />{host(nextUrl)} is available</span>
        ) : (
          <span className="flex items-center gap-1 text-red-600"><X className="size-3" />{availability.data?.reason ?? "Not available."}</span>
        )}
        {changed && canChange ? (
          <span className="flex shrink-0 gap-1">
            <Button type="button" size="xs" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            <Button type="button" size="xs" disabled={!ready || save.isPending} onClick={() => setConfirming(true)}>Save</Button>
          </span>
        ) : null}
      </div>
      {!changed ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button type="button" size="xs" variant="secondary" onClick={copy}>
            <Copy className="size-3.5" />Copy store URL
          </Button>
          <a href={storeUrl} target="_blank" rel="noreferrer" className={buttonVariants({ size: "xs", variant: "secondary" })}>
            View store<ExternalLink className="size-3.5" />
          </a>
          {subdomainsEnabled === false && hostUrl !== storeUrl ? (
            <span className="text-[11px] text-muted">
              Your store moves to {host(hostUrl)} soon. Until then it opens at {host(storeUrl)}.
            </span>
          ) : null}
        </div>
      ) : null}

      <Dialog open={confirming} onOpenChange={(open) => !save.isPending && setConfirming(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change store address?</DialogTitle>
            <DialogDescription>
              Your store moves to <span className="font-medium text-ink">{host(nextUrl)}</span>. The old address{" "}
              <span className="font-medium text-ink">{host(hostUrl)}</span> stops working right away and becomes free for other merchants.
            </DialogDescription>
          </DialogHeader>
          <p className="rounded-xl bg-surface-soft px-3 py-2 text-sm">
            Update the link anywhere you shared it: Instagram and WhatsApp bios, ads, and printed QR codes.
          </p>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => setConfirming(false)}>Cancel</Button>
            <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Changing…" : "Change address"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
