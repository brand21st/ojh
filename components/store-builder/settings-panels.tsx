"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Banknote, ExternalLink, EyeOff, Globe, Loader2, MessageCircle, ShieldCheck, Smartphone, Truck, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/hooks/use-api";
import { optimizeImageFile } from "@/lib/images/optimize-client";
import { cn } from "@/lib/utils";
import { INDIAN_MOBILE, UPI_ID } from "@/modules/storefront/schema";
import { DEFAULT_STORE_TRACKING } from "@/modules/storefront/config";
import { PaymentGatewayDefault } from "@/components/integrations/payment-gateway-default";
import { AssetField, CharCount } from "./parts";
import { StoreAddressField } from "./store-address-field";
import { TrackingSettings } from "./marketplace-settings";
import { VersionList } from "./version-history";
import { STOREFRONT_KEY, useBuilderMutations, useCanEditStore, useStoreBuilder, useStorefront, useStorefrontSave, type Storefront } from "./use-store-builder";

const SEO_TITLE_MAX = 70;
const SEO_DESCRIPTION_MAX = 180;

export function Panel({ id, title, description, children, actions }: { id?: string; title: string; description?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="scroll-mt-20 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={id ? `${id}-title` : undefined} className="text-sm font-semibold">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
        </div>
        {actions}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Loading / error wrapper for pages that need the live store settings. */
export function WithStorefront({ children }: { children: (settings: Storefront) => ReactNode }) {
  const query = useStorefront();
  if (query.isError) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-center">
        <AlertTriangle className="mx-auto size-6 text-amber-500" aria-hidden />
        <p className="mt-2 text-sm font-semibold">Could not load your store settings.</p>
        <p className="mt-1 text-xs text-muted">{query.error instanceof Error ? query.error.message : "Please try again."}</p>
        <Button className="mt-3" size="sm" onClick={() => void query.refetch()}>Retry</Button>
      </div>
    );
  }
  if (!query.data) return <div role="status" aria-label="Loading" className="space-y-3"><Skeleton className="h-32 w-full rounded-xl" /><Skeleton className="h-48 w-full rounded-xl" /></div>;
  return <>{children(query.data)}</>;
}

export function StoreSettingsPanel() {
  const { canWrite, isAdmin } = useCanEditStore();
  const queryClient = useQueryClient();
  const save = useStorefrontSave();
  const builder = useStoreBuilder();
  const { revertClassic } = useBuilderMutations();
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmHide, setConfirmHide] = useState(false);
  const [confirmClassic, setConfirmClassic] = useState(false);

  async function uploadLogo(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file || uploading) return;
    if (file.size > 15 * 1024 * 1024) {
      toast.error("Choose an image smaller than 15 MB.");
      input.value = "";
      return;
    }
    setUploading(true);
    try {
      const optimized = await optimizeImageFile(file, { maxWidth: 512, maxHeight: 512 });
      const body = new FormData();
      body.append("image", optimized);
      queryClient.setQueryData(STOREFRONT_KEY, await api<Storefront>("/api/v1/inventory/storefront/logo", { method: "POST", body }));
      toast.success("Logo uploaded.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      input.value = "";
      setUploading(false);
    }
  }

  return (
    <WithStorefront>
      {(settings) => {
        const storeName = nameDraft ?? settings.storeName;
        const displayUrl = settings.storeUrl.replace(/^https?:\/\//, "");
        const saveName = (value: string) => {
          const next = value.trim();
          if (!next || next === settings.storeName) {
            if (!next) toast.error("Store name can’t be empty.");
            setNameDraft(null);
            return;
          }
          save.mutate({ storeName: next }, { onSuccess: () => { setNameDraft(null); toast.success("Store name saved."); } });
        };
        const setPublished = (published: boolean) =>
          save.mutate({ published }, { onSuccess: () => toast.success(published ? "Store is live." : "Store hidden from customers.") });
        return (
          <div className="space-y-4">
            <Panel id="identity" title="Store identity" description="These apply immediately, on the live store and in order messages.">
              <div className="grid gap-4">
                <div className="min-w-0">
                  <div className="flex items-baseline justify-between"><Label htmlFor="store-name">Store name</Label><span className="text-[11px] tabular-nums text-muted">{storeName.length}/80</span></div>
                  <Input id="store-name" className="mt-1 min-w-0" maxLength={80} value={storeName} disabled={!canWrite} onChange={(event) => setNameDraft(event.target.value)} onBlur={(event) => saveName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()} />
                  <p className="mt-1 text-xs text-muted">Shown in the store header, footer and search results.</p>
                </div>
                <AssetField id="store-logo" label="Logo" hint="Square PNG, JPG or WebP. Transparent PNG looks best." imageUrl={settings.logoUrl} imageAlt="Store logo" canWrite={canWrite} uploading={uploading} busy={uploading || save.isPending}
                  onPick={(input) => void uploadLogo(input)} onRemove={() => save.mutate({ logoPath: null }, { onSuccess: () => toast.success("Logo removed.") })} />
              </div>
            </Panel>

            <Panel id="visibility" title="Store visibility">
              <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                <div className="min-w-0">
                  <Label htmlFor="store-published">Store visible</Label>
                  <p className="text-xs text-muted">{settings.published ? "Customers can browse and order." : "Customers see “Store temporarily unavailable”."}</p>
                </div>
                <Switch id="store-published" checked={settings.published} disabled={!canWrite || save.isPending} className="data-[state=checked]:bg-emerald-500 dark:data-[state=checked]:bg-emerald-500"
                  onCheckedChange={(next) => (next ? setPublished(true) : setConfirmHide(true))} />
              </div>
              <label className="mt-2 flex min-h-9 items-center justify-between gap-3 px-1 text-xs">
                <span>Autoplay homepage covers <span className="text-muted">(pauses on hover, respects reduced motion)</span></span>
                <Switch checked={settings.coverAutoplay === true} disabled={!canWrite} onCheckedChange={(coverAutoplay) => save.mutate({ coverAutoplay })} aria-label="Autoplay covers" />
              </label>
            </Panel>

            <Panel id="layout" title="Store layout" description={builder.data?.publishedLayout ? "Your store uses a Store Builder design." : "Your store uses the classic PostBus layout. Publish a design from Customize to switch."}>
              {builder.data?.publishedLayout && isAdmin ? (
                <Button type="button" size="xs" variant="secondary" onClick={() => setConfirmClassic(true)}>Switch back to the classic layout</Button>
              ) : null}
              <h3 className="mb-2 mt-4 text-xs font-semibold">Published versions</h3>
              <VersionList canWrite={canWrite} />
              <p className="mt-2 text-xs text-muted">Restore copies a version into your draft; review it in <Link href="/dashboard/store-builder/customize" className="text-brand underline">Customize</Link> and publish.</p>
            </Panel>

            <Dialog open={confirmHide} onOpenChange={setConfirmHide}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Hide your store?</DialogTitle>
                  <DialogDescription>Customers opening <span className="font-medium text-ink">{displayUrl}</span> will see “Store temporarily unavailable” and can’t place orders. You can turn it back on any time.</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => setConfirmHide(false)}>Keep it live</Button>
                  <Button type="button" className="bg-amber-600 hover:bg-amber-700" onClick={() => { setConfirmHide(false); setPublished(false); }}><EyeOff />Hide store</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog open={confirmClassic} onOpenChange={setConfirmClassic}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Switch back to the classic layout?</DialogTitle>
                  <DialogDescription>Customers will see the classic PostBus store again. Your Store Builder design stays in History and in your draft, so you can publish it again later.</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => setConfirmClassic(false)}>Cancel</Button>
                  <Button type="button" disabled={revertClassic.isPending} onClick={() => revertClassic.mutate(undefined, {
                    onSuccess: () => { setConfirmClassic(false); toast.success("Your store is back on the classic layout."); },
                    onError: (error) => toast.error(error.message),
                  })}>{revertClassic.isPending ? <Loader2 className="animate-spin" /> : null}Switch to classic</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        );
      }}
    </WithStorefront>
  );
}

export function SeoPanel() {
  const { canWrite } = useCanEditStore();
  const save = useStorefrontSave();
  const [title, setTitle] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  return (
    <WithStorefront>
      {(settings) => {
        const seoTitle = title ?? settings.seoTitle ?? "";
        const seoDescription = description ?? settings.seoDescription ?? "";
        const displayUrl = settings.storeUrl.replace(/^https?:\/\//, "");
        const commit = (field: "seoTitle" | "seoDescription", value: string, reset: () => void) =>
          save.mutate({ [field]: value.trim() || null }, { onSuccess: () => { reset(); toast.success("Saved."); } });
        return (
          <Panel id="seo" title="SEO and sharing" description="How your store appears in Google and when the link is shared on WhatsApp or Instagram. Saves immediately.">
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-3">
                <div className="min-w-0">
                  <div className="flex items-baseline justify-between"><Label htmlFor="store-seo-title">Page title</Label><CharCount value={seoTitle} max={SEO_TITLE_MAX} /></div>
                  <Input id="store-seo-title" className="mt-1 min-w-0" maxLength={SEO_TITLE_MAX} value={seoTitle} disabled={!canWrite} placeholder={`${settings.storeName} · Shop`} onChange={(event) => setTitle(event.target.value)} onBlur={(event) => commit("seoTitle", event.target.value, () => setTitle(null))} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-baseline justify-between"><Label htmlFor="store-seo-description">Description</Label><CharCount value={seoDescription} max={SEO_DESCRIPTION_MAX} /></div>
                  <Textarea id="store-seo-description" className="mt-1 min-h-20 min-w-0 resize-y text-xs" maxLength={SEO_DESCRIPTION_MAX} rows={3} value={seoDescription} disabled={!canWrite} placeholder={`Browse products and order directly from ${settings.storeName}.`} onChange={(event) => setDescription(event.target.value)} onBlur={(event) => commit("seoDescription", event.target.value, () => setDescription(null))} />
                  <p className="mt-1 text-xs text-muted">Also used as the tagline in your store footer and intro.</p>
                </div>
              </div>
              <div aria-label="Search result preview" className="self-start rounded-lg border border-border bg-surface-soft p-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Search preview</p>
                <p className="mt-2 truncate text-[11px] text-emerald-700 dark:text-emerald-400">{displayUrl}</p>
                <p className="truncate text-sm text-[#1a0dab] dark:text-sky-400">{seoTitle || `${settings.storeName} · Shop`}</p>
                <p className="line-clamp-2 text-xs text-muted">{seoDescription || `Browse products and order directly from ${settings.storeName}.`}</p>
              </div>
            </div>
          </Panel>
        );
      }}
    </WithStorefront>
  );
}

export function TrackingPanel() {
  const { canWrite, isAdmin } = useCanEditStore();
  const save = useStorefrontSave();
  return (
    <WithStorefront>
      {(settings) => (
        <Panel id="tracking" title="Analytics and tracking pixels" description="Meta Pixel, Google Analytics 4, Microsoft Clarity and Google Tag Manager on your store.">
          <TrackingSettings tracking={settings.tracking ?? DEFAULT_STORE_TRACKING} canTrack={canWrite && isAdmin} saving={save.isPending} onSave={(patch) => save.mutate(patch, { onSuccess: () => toast.success("Tracking saved.") })} />
        </Panel>
      )}
    </WithStorefront>
  );
}

export function UpiPaymentsPanel() {
  const { canWrite } = useCanEditStore();
  const queryClient = useQueryClient();
  const save = useStorefrontSave();
  const [upi, setUpi] = useState<string | null>(null);
  const [gpay, setGpay] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  async function uploadQr(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file || uploading) return;
    setUploading(true);
    try {
      const optimized = await optimizeImageFile(file, { maxWidth: 1920, maxHeight: 1350 });
      const body = new FormData();
      body.append("image", optimized);
      queryClient.setQueryData(STOREFRONT_KEY, await api<Storefront>("/api/v1/inventory/storefront/qr", { method: "POST", body }));
      toast.success("Payment QR uploaded.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      input.value = "";
      setUploading(false);
    }
  }
  return (
    <WithStorefront>
      {(settings) => {
        const upiId = upi ?? settings.upiId ?? "";
        const gpayNumber = gpay ?? settings.gpayNumber ?? "";
        const upiInvalid = Boolean(upiId.trim()) && !UPI_ID.test(upiId.trim());
        const gpayInvalid = Boolean(gpayNumber.trim()) && !INDIAN_MOBILE.test(gpayNumber.trim().replace(/[\s-]/g, ""));
        const commit = (field: "upiId" | "gpayNumber", value: string, reset: () => void) => {
          const next = value.trim();
          if (next && field === "upiId" && !UPI_ID.test(next)) return;
          if (next && field === "gpayNumber" && !INDIAN_MOBILE.test(next.replace(/[\s-]/g, ""))) return;
          save.mutate({ [field]: next || null }, { onSuccess: reset });
        };
        return (
          <Panel id="upi" title="WhatsApp order payments (UPI)" description="Sent to customers when you process a WhatsApp order that needs advance or prepaid payment. Not used for PostBus billing.">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0">
                <Label htmlFor="store-upi">UPI ID</Label>
                <Input id="store-upi" className="mt-1 min-w-0" value={upiId} disabled={!canWrite} autoComplete="off" spellCheck={false} placeholder="yourname@okhdfcbank" aria-invalid={upiInvalid || undefined} aria-describedby={upiInvalid ? "store-upi-error" : undefined} onChange={(event) => setUpi(event.target.value)} onBlur={(event) => commit("upiId", event.target.value, () => setUpi(null))} />
                {upiInvalid ? <p id="store-upi-error" className="mt-1 text-xs text-red-600">Use a UPI ID like name@okbank.</p> : null}
              </div>
              <div className="min-w-0">
                <Label htmlFor="store-gpay">GPay number</Label>
                <Input id="store-gpay" className="mt-1 min-w-0" inputMode="tel" autoComplete="off" value={gpayNumber} disabled={!canWrite} placeholder="98XXXXXXXX" aria-invalid={gpayInvalid || undefined} aria-describedby={gpayInvalid ? "store-gpay-error" : undefined} onChange={(event) => setGpay(event.target.value)} onBlur={(event) => commit("gpayNumber", event.target.value, () => setGpay(null))} />
                {gpayInvalid ? <p id="store-gpay-error" className="mt-1 text-xs text-red-600">Use a 10-digit Indian mobile number.</p> : null}
              </div>
            </div>
            <div className="mt-3">
              <AssetField id="store-qr" label="UPI / GPay QR" hint="Customers receive this image with the payment instructions." imageUrl={settings.qrImageUrl ?? null} imageAlt="Payment QR code" canWrite={canWrite} uploading={uploading} busy={uploading || save.isPending}
                onPick={(input) => void uploadQr(input)} onRemove={() => save.mutate({ qrImagePath: null }, { onSuccess: () => toast.success("Payment QR removed.") })} />
            </div>
          </Panel>
        );
      }}
    </WithStorefront>
  );
}

export function PaymentsPanel() {
  return (
    <div className="space-y-4">
      <Panel id="gateways" title="Online payment gateways" description="Your own Razorpay or Cashfree account takes card, UPI and netbanking payments at checkout. Money goes straight to you.">
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            { href: "/dashboard/integrations/razorpay", name: "Razorpay", body: "Connect your Razorpay keys and webhook." },
            { href: "/dashboard/integrations/cashfree", name: "Cashfree", body: "Connect your Cashfree app ID and secret." },
          ].map((item) => (
            <Link key={item.href} href={item.href} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-3 hover:bg-surface-soft focus-visible:outline-2 focus-visible:outline-brand">
              <span className="min-w-0"><span className="block text-sm font-medium">{item.name}</span><span className="block text-xs text-muted">{item.body}</span></span>
              <ExternalLink className="size-4 shrink-0 text-muted" aria-hidden />
            </Link>
          ))}
        </div>
        <div className="mt-4"><PaymentGatewayDefault /></div>
      </Panel>
      <UpiPaymentsPanel />
    </div>
  );
}

export function DomainsPanel() {
  const { canWrite, isAdmin } = useCanEditStore();
  const queryClient = useQueryClient();
  return (
    <WithStorefront>
      {(settings) => (
        <div className="space-y-4">
          <Panel id="address" title="Store address" description="The link customers open. Changing it updates both the path link and your subdomain.">
            <StoreAddressField<Storefront>
              workspace={settings.workspace}
              storeUrl={settings.storeUrl}
              subdomainUrl={settings.storeSubdomainUrl}
              hostSuffix={settings.storeHostSuffix}
              subdomainsEnabled={settings.subdomainsEnabled}
              canChange={canWrite && isAdmin}
              onSaved={(next) => queryClient.setQueryData(STOREFRONT_KEY, next)}
            />
            {!isAdmin ? <p className="mt-2 text-xs text-muted">Only owners and admins can change the store address.</p> : null}
          </Panel>
          <Panel id="hosts" title="Where your store is available">
            <ul className="grid gap-2 text-sm">
              <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <span className="flex min-w-0 items-center gap-2"><Globe className="size-4 shrink-0 text-muted" aria-hidden /><span className="truncate">{(settings.storeSubdomainUrl ?? "").replace(/^https?:\/\//, "")}</span></span>
                <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", settings.subdomainsEnabled ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-zinc-500/10 text-muted")}>{settings.subdomainsEnabled ? "Active" : "Coming soon"}</span>
              </li>
              <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <span className="flex min-w-0 items-center gap-2"><Globe className="size-4 shrink-0 text-muted" aria-hidden /><span className="truncate">{settings.storeUrl.replace(/^https?:\/\//, "")}</span></span>
                <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">Active</span>
              </li>
              <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-muted">
                <span>Your own domain (e.g. www.yourbrand.in)</span>
                <span className="rounded bg-zinc-500/10 px-1.5 py-0.5 text-[11px] font-medium">Not available yet</span>
              </li>
            </ul>
          </Panel>
        </div>
      )}
    </WithStorefront>
  );
}

function Fact({ icon, title, body, href, linkLabel }: { icon: ReactNode; title: string; body: string; href?: string; linkLabel?: string }) {
  return (
    <li className="flex gap-3 rounded-lg border border-border p-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-soft text-muted">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted">{body}</span>
        {href ? <Link href={href} className="mt-1 inline-block text-xs font-medium text-brand hover:underline">{linkLabel ?? "Manage"} →</Link> : null}
      </span>
    </li>
  );
}

export function CheckoutPanel() {
  return (
    <WithStorefront>
      {(settings) => {
        const payments = settings.footerSources?.payments;
        return (
          <div className="space-y-4">
            <Panel id="checkout-flow" title="Checkout experience" description="PostBus checkout is a single page: phone first, WhatsApp OTP, saved addresses and PIN code lookup.">
              <ul className="grid gap-2 sm:grid-cols-2">
                <Fact icon={<Smartphone className="size-4" />} title="Phone-first checkout with WhatsApp OTP" body="Returning buyers verify once and get their saved addresses back." />
                <Fact icon={<ShieldCheck className="size-4" />} title="Coupons and auto-apply offers" body="Codes, magic links and automatic store-wide offers apply at checkout." href="/dashboard/store-builder/marketing?tab=coupons" linkLabel="Coupons" />
                <Fact icon={<Truck className="size-4" />} title="Shipping by India Post" body="Store orders arrive in Orders and follow your booking automation." href="/dashboard/integrations/india-post" linkLabel="India Post settings" />
                <Fact icon={<MessageCircle className="size-4" />} title="Order updates on WhatsApp" body="Buyers get confirmation and tracking messages automatically." href="/dashboard/automation" linkLabel="Automation" />
              </ul>
            </Panel>
            <Panel id="payment-modes" title="Payment options" description="Set per product in Inventory, so each product can allow COD, prepaid, or COD with an advance.">
              <ul className="grid gap-2 sm:grid-cols-3">
                <Fact icon={<Banknote className="size-4" />} title={payments?.cod ? "Cash on delivery: on" : "Cash on delivery: off"} body="Enabled on at least one product." />
                <Fact icon={<Wallet className="size-4" />} title={payments?.prepaid ? "Prepaid: on" : "Prepaid: off"} body="Online gateway or UPI." />
                <Fact icon={<Banknote className="size-4" />} title={payments?.partial ? "Partial COD: on" : "Partial COD: off"} body="Advance paid online, rest on delivery." />
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href="/dashboard/inventory?tab=products" className={buttonVariants({ size: "xs", variant: "secondary" })}>Edit product payment options</Link>
                <Link href="/dashboard/store-builder/payments" className={buttonVariants({ size: "xs", variant: "secondary" })}>Payment gateways</Link>
              </div>
            </Panel>
          </div>
        );
      }}
    </WithStorefront>
  );
}
