"use client";

import Link from "next/link";
import { Plus, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  MAX_MENU_LINKS,
  SECTION_LABELS,
  STORE_FONTS,
  type LayoutSection,
  type LayoutTokens,
  type MenuLink,
  type StoreLayout,
} from "@/modules/storefront/layout/schema";
import { videoEmbed } from "@/modules/storefront/layout/video";
import { STORE_POLICY_SLUGS, STORE_POLICY_TITLES } from "@/modules/storefront/footer";
import { ACCENT_PRESETS, HEX_COLOR } from "./parts";
import { ProductPicker, type PickedProduct } from "./product-picker";

export type EditorCategory = { id: string; name: string };

const selectClass = "mt-1 h-9 w-full min-w-0 rounded-md border border-border bg-card px-2 text-xs";

function Field({ id, label, hint, children, count }: { id: string; label: string; hint?: string; children: React.ReactNode; count?: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {count ? <span className="text-[11px] tabular-nums text-muted">{count}</span> : null}
      </div>
      {children}
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

function TextField({ id, label, value, max, placeholder, hint, onChange, type = "text" }: { id: string; label: string; value: string; max: number; placeholder?: string; hint?: string; onChange: (value: string) => void; type?: string }) {
  return (
    <Field id={id} label={label} hint={hint} count={`${value.length}/${max}`}>
      <Input id={id} type={type} className="mt-1 min-w-0" value={value} maxLength={max} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

function AreaField({ id, label, value, max, placeholder, onChange, rows = 3 }: { id: string; label: string; value: string; max: number; placeholder?: string; onChange: (value: string) => void; rows?: number }) {
  return (
    <Field id={id} label={label} count={`${value.length}/${max}`}>
      <Textarea id={id} className="mt-1 min-h-20 min-w-0 resize-y text-xs" rows={rows} value={value} maxLength={max} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

function Choice<T extends string>({ id, label, value, options, onChange }: { id: string; label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return (
    <Field id={id} label={label}>
      <select id={id} className={selectClass} value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </Field>
  );
}

type Patch<T> = (next: T) => void;

export function SectionSettingsForm({
  section,
  categories,
  featuredIds,
  featuredKnown,
  onSettings,
  onFeatured,
}: {
  section: LayoutSection;
  categories: EditorCategory[];
  featuredIds: string[];
  featuredKnown?: PickedProduct[];
  onSettings: (settings: LayoutSection["settings"]) => void;
  onFeatured: (ids: string[]) => void;
}) {
  const key = `sec-${section.id}`;
  const meta = SECTION_LABELS[section.type];
  const settings = section.settings as Record<string, unknown>;
  const set = (patch: Record<string, unknown>) => onSettings({ ...settings, ...patch } as LayoutSection["settings"]);
  const titleField = (fallback: string) => (
    <TextField id={`${key}-title`} label="Heading" value={String(settings.title ?? "")} max={80} placeholder={fallback} onChange={(title) => set({ title })} hint="Leave empty to hide the heading." />
  );

  let body: React.ReactNode = null;
  switch (section.type) {
    case "hero": {
      const s = section.settings as LayoutSection<"hero">["settings"];
      body = (
        <>
          <Choice id={`${key}-style`} label="Style" value={s.style} onChange={(style) => set({ style })} options={[
            { value: "covers", label: "Covers (falls back to intro)" },
            { value: "intro", label: "Branded intro with product photos" },
            { value: "split", label: "Split: photo and text side by side" },
            { value: "statement", label: "Statement: giant headline with photo" },
          ]} />
          <p className="text-xs text-muted">Covers come from Cover Studio and keep their own schedule. <Link className="text-brand underline" href="/dashboard/store-builder/marketing?tab=covers">Manage covers</Link></p>
          <TextField id={`${key}-ht`} label="Intro headline" value={s.title} max={80} placeholder="Your store name" onChange={(title) => set({ title })} />
          <AreaField id={`${key}-hs`} label="Intro text" value={s.subtitle} max={200} placeholder="Your SEO description" onChange={(subtitle) => set({ subtitle })} />
          <TextField id={`${key}-hc`} label="Button label" value={s.ctaLabel} max={30} placeholder="Shop all products" onChange={(ctaLabel) => set({ ctaLabel })} />
        </>
      );
      break;
    }
    case "trust_badges": {
      const items = (section.settings as LayoutSection<"trust_badges">["settings"]).items;
      body = (
        <>
          <p className="text-xs text-muted">Leave empty to show automatic badges based on your catalog (India Post delivery, COD, prepaid, returns).</p>
          {items.map((item, index) => (
            <div key={index} className="grid gap-2 rounded-lg border border-border p-2">
              <div className="flex items-center justify-between"><span className="text-xs font-medium">Badge {index + 1}</span>
                <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove badge ${index + 1}`} onClick={() => set({ items: items.filter((_, i) => i !== index) })}><Trash2 /></Button></div>
              <TextField id={`${key}-b${index}t`} label="Title" value={item.title} max={40} onChange={(title) => set({ items: items.map((it, i) => (i === index ? { ...it, title } : it)) })} />
              <TextField id={`${key}-b${index}b`} label="Detail" value={item.body} max={80} onChange={(text) => set({ items: items.map((it, i) => (i === index ? { ...it, body: text } : it)) })} />
            </div>
          ))}
          {items.length < 4 ? <Button type="button" size="xs" variant="secondary" onClick={() => set({ items: [...items, { title: "Secure payments", body: "UPI, cards and COD" }] })}><Plus />Add badge</Button> : null}
        </>
      );
      break;
    }
    case "category_grid": {
      const s = section.settings as LayoutSection<"category_grid">["settings"];
      body = (
        <>
          <Choice id={`${key}-cstyle`} label="Layout" value={s.style} onChange={(style) => set({ style })} options={[
            { value: "tiles", label: "Tiles" },
            { value: "round", label: "Round circles (swipeable)" },
            { value: "mosaic", label: "Photo mosaic" },
            { value: "photo", label: "Photo grid with captions" },
            { value: "rows", label: "Product row per category" },
          ]} />
          <TextField id={`${key}-eyebrow`} label="Small label above the heading" value={s.eyebrow} max={40} placeholder="Curated for you" onChange={(eyebrow) => set({ eyebrow })} />
          {titleField("Shop by category")}
          {s.style === "rows" ? <p className="text-xs text-muted">Shows up to 4 categories, each with a banner tile and its products.</p> : null}
          <fieldset className="min-w-0">
            <legend className="text-xs font-medium">Categories</legend>
            <p className="text-xs text-muted">None selected shows all active categories (needs at least two).</p>
            <div className="mt-2 max-h-48 space-y-0.5 overflow-y-auto">
              {categories.map((category) => (
                <label key={category.id} className="flex min-h-9 items-center gap-2 rounded-md px-2 text-xs hover:bg-surface-soft">
                  <input type="checkbox" className="size-4 accent-brand" checked={s.categoryIds.includes(category.id)} disabled={!s.categoryIds.includes(category.id) && s.categoryIds.length >= 12}
                    onChange={(event) => set({ categoryIds: event.target.checked ? [...s.categoryIds, category.id] : s.categoryIds.filter((id) => id !== category.id) })} />
                  {category.name}
                </label>
              ))}
              {!categories.length ? <p className="text-xs text-muted">No categories yet. <Link className="text-brand underline" href="/dashboard/store-builder/products">Create collections</Link></p> : null}
            </div>
          </fieldset>
        </>
      );
      break;
    }
    case "featured_products":
      body = (
        <>
          {titleField("Featured picks")}
          <ProductPicker id={`${key}-picker`} label="Featured products (first 10 shown)" ids={featuredIds} max={24} known={featuredKnown} onChange={onFeatured} highlightFirst={10} />
        </>
      );
      break;
    case "collection": {
      const s = section.settings as LayoutSection<"collection">["settings"];
      body = (
        <>
          {titleField("Collection name")}
          <Field id={`${key}-cat`} label="Category">
            <select id={`${key}-cat`} className={selectClass} value={s.categoryId ?? ""} onChange={(event) => set({ categoryId: event.target.value || null })}>
              <option value="">Choose a category…</option>
              {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          </Field>
          <Field id={`${key}-limit`} label={`Products shown: ${s.limit}`}>
            <input id={`${key}-limit`} type="range" min={2} max={12} value={s.limit} className="mt-2 w-full accent-brand" onChange={(event) => set({ limit: Number(event.target.value) })} />
          </Field>
        </>
      );
      break;
    }
    case "promo_banner": {
      const s = section.settings as LayoutSection<"promo_banner">["settings"];
      body = (
        <>
          <TextField id={`${key}-pt`} label="Headline" value={s.title} max={80} onChange={(title) => set({ title })} />
          <AreaField id={`${key}-pb`} label="Text" value={s.body} max={200} placeholder="Flat 20% off on prepaid orders this week." onChange={(text) => set({ body: text })} />
          <TextField id={`${key}-pl`} label="Button label" value={s.ctaLabel} max={30} placeholder="Shop the sale" onChange={(ctaLabel) => set({ ctaLabel })} />
          <TextField id={`${key}-ph`} label="Button link" value={s.ctaHref} max={300} placeholder="#all-products or https://…" hint="Use #all-products, a path like /category/sarees, or a full https:// link." onChange={(ctaHref) => set({ ctaHref })} />
          <TextField id={`${key}-pi`} label="Image URL (optional)" value={s.imageUrl} max={300} placeholder="https://…" onChange={(imageUrl) => set({ imageUrl })} />
          <Choice id={`${key}-tone`} label="Colour" value={s.tone} onChange={(tone) => set({ tone })} options={[{ value: "accent", label: "Accent" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />
        </>
      );
      break;
    }
    case "video_shopping": {
      const s = section.settings as LayoutSection<"video_shopping">["settings"];
      body = (
        <>
          {titleField("Watch and shop")}
          <Choice id={`${key}-vlayout`} label="Layout" value={s.layout} onChange={(layout) => set({ layout })} options={[
            { value: "reels", label: "Reels: vertical videos with the product pinned below" },
            { value: "grid", label: "Grid: wide videos with product cards" },
          ]} />
          {s.layout === "reels" ? <p className="text-xs text-muted">YouTube Shorts links look best here. The first product you pick is pinned under each video.</p> : null}
          {s.videos.map((video, index) => {
            const invalid = Boolean(video.url) && !videoEmbed(video.url);
            const update = (patch: Partial<typeof video>) => set({ videos: s.videos.map((v, i) => (i === index ? { ...v, ...patch } : v)) });
            return (
              <div key={index} className="grid gap-2 rounded-lg border border-border p-2">
                <div className="flex items-center justify-between"><span className="text-xs font-medium">Video {index + 1}</span>
                  <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove video ${index + 1}`} onClick={() => set({ videos: s.videos.filter((_, i) => i !== index) })}><Trash2 /></Button></div>
                <div className="min-w-0">
                  <Label htmlFor={`${key}-v${index}`}>YouTube or Vimeo link</Label>
                  <Input id={`${key}-v${index}`} className="mt-1 min-w-0" type="url" value={video.url} placeholder="https://youtu.be/…" aria-invalid={invalid || undefined} onChange={(event) => update({ url: event.target.value })} />
                  {invalid ? <p className="mt-1 text-xs text-red-600">Use a YouTube or Vimeo link.</p> : null}
                </div>
                <TextField id={`${key}-vc${index}`} label="Caption" value={video.caption} max={120} onChange={(caption) => update({ caption })} />
                <ProductPicker id={`${key}-vp${index}`} label="Shoppable products" ids={video.productIds} max={4} onChange={(productIds) => update({ productIds })} />
              </div>
            );
          })}
          {s.videos.length < 8 ? <Button type="button" size="xs" variant="secondary" onClick={() => set({ videos: [...s.videos, { url: "", caption: "", productIds: [] }] })}><Plus />Add video</Button> : null}
          <p className="text-xs text-muted">Videos load only when a shopper taps play, so they don’t slow your store down.</p>
        </>
      );
      break;
    }
    case "bundles":
      body = <>{titleField("Better together")}<p className="text-xs text-muted">Shows your published bundles. <Link className="text-brand underline" href="/dashboard/store-builder/products#bundles">Manage bundles</Link></p></>;
      break;
    case "upsell":
      body = <>{titleField("You may also like")}<p className="text-xs text-muted">Uses the upsell and cross-sell products you link on each product in Inventory.</p></>;
      break;
    case "best_sellers":
      body = <>{titleField("Best sellers")}<p className="text-xs text-muted">Filled automatically from your orders.</p></>;
      break;
    case "testimonials": {
      const s = section.settings as LayoutSection<"testimonials">["settings"];
      body = (
        <>
          {titleField("What customers say")}
          {s.items.map((item, index) => {
            const update = (patch: Partial<typeof item>) => set({ items: s.items.map((it, i) => (i === index ? { ...it, ...patch } : it)) });
            return (
              <div key={index} className="grid gap-2 rounded-lg border border-border p-2">
                <div className="flex items-center justify-between"><span className="text-xs font-medium">Review {index + 1}</span>
                  <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove review ${index + 1}`} onClick={() => set({ items: s.items.filter((_, i) => i !== index) })}><Trash2 /></Button></div>
                <TextField id={`${key}-tn${index}`} label="Customer name" value={item.name} max={60} onChange={(name) => update({ name })} />
                <TextField id={`${key}-tl${index}`} label="City (optional)" value={item.location} max={60} onChange={(location) => update({ location })} />
                <AreaField id={`${key}-tq${index}`} label="Review" value={item.quote} max={400} onChange={(quote) => update({ quote })} />
                <div role="radiogroup" aria-label="Rating" className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} type="button" role="radio" aria-checked={item.rating === n} aria-label={`${n} star${n === 1 ? "" : "s"}`} className="rounded p-0.5 text-amber-500 focus-visible:outline-2 focus-visible:outline-brand" onClick={() => update({ rating: n })}>
                      <Star className="size-4" fill={n <= item.rating ? "currentColor" : "none"} />
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {s.items.length < 12 ? <Button type="button" size="xs" variant="secondary" onClick={() => set({ items: [...s.items, { name: "Customer", quote: "Lovely quality and quick delivery!", rating: 5, location: "" }] })}><Plus />Add review</Button> : null}
          <p className="text-xs text-muted">Only publish genuine reviews from your customers.</p>
        </>
      );
      break;
    }
    case "rich_text": {
      const s = section.settings as LayoutSection<"rich_text">["settings"];
      body = (
        <>
          <TextField id={`${key}-rt`} label="Heading" value={s.title} max={80} placeholder="Our story" onChange={(title) => set({ title })} />
          <AreaField id={`${key}-rb`} label="Text" value={s.body} max={1500} rows={6} placeholder="Tell shoppers who you are and why they can trust you. Leave a blank line between paragraphs." onChange={(text) => set({ body: text })} />
        </>
      );
      break;
    }
    case "countdown": {
      const s = section.settings as LayoutSection<"countdown">["settings"];
      const local = s.endsAt ? toLocalInput(s.endsAt) : "";
      body = (
        <>
          <TextField id={`${key}-ce`} label="Small label" value={s.eyebrow} max={40} placeholder="Limited drop" onChange={(eyebrow) => set({ eyebrow })} />
          <TextField id={`${key}-ct`} label="Heading" value={s.title} max={80} onChange={(title) => set({ title })} />
          <Field id={`${key}-cend`} label="Ends at" hint="The section hides itself when the timer reaches zero.">
            <Input id={`${key}-cend`} type="datetime-local" className="mt-1 min-w-0" value={local} onChange={(event) => set({ endsAt: event.target.value ? new Date(event.target.value).toISOString() : null })} />
          </Field>
          <AreaField id={`${key}-cb`} label="Text" value={s.body} max={160} placeholder="Reserve the pieces before they disappear." onChange={(text) => set({ body: text })} />
          <TextField id={`${key}-cl`} label="Button label" value={s.ctaLabel} max={30} onChange={(ctaLabel) => set({ ctaLabel })} />
          <TextField id={`${key}-ch`} label="Button link" value={s.ctaHref} max={300} placeholder="#all-products" onChange={(ctaHref) => set({ ctaHref })} />
          {!s.endsAt ? <p className="text-xs text-amber-700 dark:text-amber-300">Set an end time to show this section.</p> : null}
        </>
      );
      break;
    }
    case "catalog":
      body = <>{titleField("All products")}<p className="text-xs text-muted">Always shown so shoppers can search, filter and browse everything.</p></>;
      break;
  }

  return (
    <div className="grid gap-3">
      <div>
        <p className="text-sm font-semibold">{meta.label}</p>
        <p className="text-xs text-muted">{meta.description}</p>
      </div>
      {body}
    </div>
  );
}

/** ISO → value for <input type="datetime-local"> in the merchant's timezone. */
function toLocalInput(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const FONT_LABELS: Record<(typeof STORE_FONTS)[number], string> = {
  geist: "Geist", inter: "Inter", manrope: "Manrope", poppins: "Poppins", playfair: "Playfair Display", "dm-serif": "DM Serif Display",
};

function ColorField({ id, label, value, onChange, presets }: { id: string; label: string; value: string; onChange: (value: string) => void; presets?: string[] }) {
  const valid = HEX_COLOR.test(value);
  return (
    <div className="min-w-0">
      <Label htmlFor={`${id}-hex`}>{label}</Label>
      {presets ? (
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={`${label} presets`}>
          {presets.map((hex) => (
            <button key={hex} type="button" aria-label={`Use ${hex}`} aria-pressed={value.toLowerCase() === hex.toLowerCase()} title={hex} onClick={() => onChange(hex)}
              className={cn("size-7 rounded-full border border-black/10 transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand", value.toLowerCase() === hex.toLowerCase() && "ring-2 ring-offset-2 ring-offset-card")}
              style={{ backgroundColor: hex, ["--tw-ring-color" as string]: hex }} />
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex min-w-0 items-center gap-2">
        <Input id={id} aria-label={`Pick ${label.toLowerCase()}`} type="color" className="shrink-0 cursor-pointer" value={valid ? value : "#000000"} onChange={(event) => onChange(event.target.value)} />
        <Input id={`${id}-hex`} className="min-w-0 font-mono uppercase" maxLength={7} value={value} aria-invalid={!valid || undefined} onChange={(event) => onChange(event.target.value.startsWith("#") ? event.target.value : `#${event.target.value}`)} />
      </div>
      {!valid ? <p className="mt-1 text-xs text-red-600">Use a hex colour like #E11D48.</p> : null}
    </div>
  );
}

export function ThemeTokensForm({ tokens, onChange }: { tokens: LayoutTokens; onChange: Patch<LayoutTokens> }) {
  const set = (patch: Partial<LayoutTokens>) => onChange({ ...tokens, ...patch });
  const fonts = STORE_FONTS.map((value) => ({ value, label: FONT_LABELS[value] }));
  return (
    <div className="grid gap-4">
      <ColorField id="tok-accent" label="Accent colour" value={tokens.accent} presets={ACCENT_PRESETS} onChange={(accent) => set({ accent })} />
      <div className="grid gap-3 sm:grid-cols-2">
        <ColorField id="tok-secondary" label="Secondary" value={tokens.secondary} onChange={(secondary) => set({ secondary })} />
        <ColorField id="tok-bg" label="Page background" value={tokens.background} onChange={(background) => set({ background })} />
        <ColorField id="tok-ink" label="Text colour" value={tokens.ink} onChange={(ink) => set({ ink })} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Choice id="tok-font" label="Body font" value={tokens.font} options={fonts} onChange={(font) => set({ font })} />
        <Choice id="tok-hfont" label="Heading font" value={tokens.headingFont} options={fonts} onChange={(headingFont) => set({ headingFont })} />
        <Choice id="tok-radius" label="Corners" value={tokens.radius} onChange={(radius) => set({ radius })} options={[{ value: "sharp", label: "Sharp" }, { value: "rounded", label: "Rounded" }, { value: "pill", label: "Extra round" }]} />
        <Choice id="tok-card" label="Product cards" value={tokens.card} onChange={(card) => set({ card })} options={[{ value: "bordered", label: "Bordered" }, { value: "elevated", label: "Shadow" }, { value: "plain", label: "Plain" }]} />
        <Choice id="tok-header" label="Header style" value={tokens.header} onChange={(header) => set({ header })} options={[
          { value: "classic", label: "Logo left, big search" },
          { value: "inline", label: "Logo left, menu in the bar" },
          { value: "split", label: "Menu left, logo centred" },
          { value: "centered", label: "Logo centred" },
          { value: "minimal", label: "Minimal" },
        ]} />
        <Choice id="tok-density" label="Spacing" value={tokens.density} onChange={(density) => set({ density })} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} />
      </div>
      <label className="flex min-h-9 items-center justify-between gap-3 text-xs">
        <span>Bottom tab bar on phones <span className="text-muted">(Home, Shop, Categories, Cart)</span></span>
        <Switch checked={tokens.mobileNav} onCheckedChange={(mobileNav) => set({ mobileNav })} aria-label="Bottom tab bar on phones" />
      </label>
      {tokens.header === "inline" || tokens.header === "split" ? <p className="text-xs text-muted">Add menu links under Header so they show in the bar.</p> : null}
    </div>
  );
}

export function HeaderForm({ header, sections, categories, onChange }: { header: StoreLayout["header"]; sections: LayoutSection[]; categories: EditorCategory[]; onChange: Patch<StoreLayout["header"]> }) {
  const set = (patch: Partial<StoreLayout["header"]>) => onChange({ ...header, ...patch });
  const menu = header.menu;
  const updateLink = (index: number, patch: Partial<MenuLink>) => set({ menu: menu.map((link, i) => (i === index ? { ...link, ...patch } : link)) });
  const valueOptions = (kind: MenuLink["kind"]) =>
    kind === "category" ? categories.map((c) => ({ value: c.id, label: c.name }))
      : kind === "policy" ? STORE_POLICY_SLUGS.map((slug) => ({ value: slug, label: STORE_POLICY_TITLES[slug] }))
        : kind === "section" ? sections.filter((s) => s.visible && s.type !== "catalog").map((s) => ({ value: s.id, label: (s.settings as { title?: string }).title || SECTION_LABELS[s.type].label }))
          : [];
  return (
    <div className="grid gap-4">
      <section aria-labelledby="hdr-ann" className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <h4 id="hdr-ann" className="text-xs font-semibold">Announcement bar</h4>
          <Switch aria-label="Show announcement bar" checked={header.announcement.enabled} onCheckedChange={(enabled) => set({ announcement: { ...header.announcement, enabled } })} />
        </div>
        {header.announcement.enabled ? (
          <>
            <TextField id="hdr-ann-text" label="Message" value={header.announcement.text} max={120} placeholder="Free shipping on prepaid orders above ₹999" onChange={(text) => set({ announcement: { ...header.announcement, text } })} />
            <TextField id="hdr-ann-href" label="Link (optional)" value={header.announcement.href} max={300} placeholder="#all-products" onChange={(href) => set({ announcement: { ...header.announcement, href } })} />
            <Choice id="hdr-ann-style" label="Style" value={header.announcement.style} onChange={(style) => set({ announcement: { ...header.announcement, style } })} options={[{ value: "static", label: "Static" }, { value: "marquee", label: "Scrolling ticker" }]} />
          </>
        ) : null}
      </section>
      <label className="flex min-h-9 items-center justify-between gap-3 text-xs">
        <span>Category chips under the header</span>
        <Switch checked={header.showCategoryBar} onCheckedChange={(showCategoryBar) => set({ showCategoryBar })} aria-label="Show category chips" />
      </label>
      <section aria-labelledby="hdr-menu" className="grid gap-2">
        <div className="flex items-baseline justify-between"><h4 id="hdr-menu" className="text-xs font-semibold">Menu links</h4><span className="text-[11px] text-muted">{menu.length}/{MAX_MENU_LINKS}</span></div>
        {menu.map((link, index) => {
          const options = valueOptions(link.kind);
          return (
            <div key={index} className="grid gap-2 rounded-lg border border-border p-2">
              <div className="flex items-center justify-between"><span className="text-xs font-medium">Link {index + 1}</span>
                <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove link ${index + 1}`} onClick={() => set({ menu: menu.filter((_, i) => i !== index) })}><Trash2 /></Button></div>
              <TextField id={`menu-${index}-label`} label="Label" value={link.label} max={30} onChange={(label) => updateLink(index, { label })} />
              <Choice id={`menu-${index}-kind`} label="Opens" value={link.kind} onChange={(kind) => updateLink(index, { kind, value: valueOptions(kind)[0]?.value ?? (kind === "url" ? "https://" : "") })} options={[
                { value: "category", label: "A category" }, { value: "section", label: "A home page section" }, { value: "policy", label: "A policy page" }, { value: "url", label: "A web link" },
              ]} />
              {link.kind === "url" ? (
                <TextField id={`menu-${index}-url`} label="URL" type="url" value={link.value} max={300} onChange={(value) => updateLink(index, { value })} />
              ) : (
                <Field id={`menu-${index}-value`} label="Target">
                  <select id={`menu-${index}-value`} className={selectClass} value={link.value} onChange={(event) => updateLink(index, { value: event.target.value })}>
                    {!options.length ? <option value="">Nothing to link yet</option> : null}
                    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </Field>
              )}
            </div>
          );
        })}
        {menu.length < MAX_MENU_LINKS ? (
          <Button type="button" size="xs" variant="secondary" className="justify-self-start" onClick={() => set({ menu: [...menu, categories[0] ? { label: categories[0].name.slice(0, 30), kind: "category", value: categories[0].id } : { label: "Shipping", kind: "policy", value: "shipping" }] })}>
            <Plus />Add link
          </Button>
        ) : null}
      </section>
    </div>
  );
}

export function ProductPageForm({ value, onChange }: { value: StoreLayout["productPage"]; onChange: Patch<StoreLayout["productPage"]> }) {
  const set = (patch: Partial<StoreLayout["productPage"]>) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted">Shown on every product page, under delivery, payment and returns.</p>
      {value.highlights.map((item, index) => {
        const update = (patch: Partial<typeof item>) => set({ highlights: value.highlights.map((it, i) => (i === index ? { ...it, ...patch } : it)) });
        return (
          <div key={index} className="grid gap-2 rounded-lg border border-border p-2">
            <div className="flex items-center justify-between"><span className="text-xs font-medium">Selling point {index + 1}</span>
              <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove selling point ${index + 1}`} onClick={() => set({ highlights: value.highlights.filter((_, i) => i !== index) })}><Trash2 /></Button></div>
            <TextField id={`pp-h${index}t`} label="Title" value={item.title} max={40} onChange={(title) => update({ title })} />
            <TextField id={`pp-h${index}b`} label="Detail" value={item.body} max={90} onChange={(body) => update({ body })} />
          </div>
        );
      })}
      {value.highlights.length < 4 ? <Button type="button" size="xs" variant="secondary" className="justify-self-start" onClick={() => set({ highlights: [...value.highlights, { title: "Handpicked quality", body: "Checked before it ships" }] })}><Plus />Add selling point</Button> : null}
      <AreaField id="pp-guarantee" label="Reassurance line" value={value.guarantee} max={160} placeholder="Packed with care and shipped within 24 hours." onChange={(guarantee) => set({ guarantee })} />
      <TextField id="pp-related" label="Related products heading" value={value.relatedTitle} max={80} onChange={(relatedTitle) => set({ relatedTitle })} />
    </div>
  );
}

export function WhatsAppButtonForm({ value, phone, onChange }: { value: StoreLayout["whatsappButton"]; phone: string | null | undefined; onChange: Patch<StoreLayout["whatsappButton"]> }) {
  const set = (patch: Partial<StoreLayout["whatsappButton"]>) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-3">
      <label className="flex min-h-9 items-center justify-between gap-3 text-xs">
        <span>Floating WhatsApp chat button</span>
        <Switch checked={value.enabled} onCheckedChange={(enabled) => set({ enabled })} aria-label="Show WhatsApp button" />
      </label>
      {phone ? (
        <p className="text-xs text-muted">Opens a chat with +91 {phone}, from your business profile. <Link className="text-brand underline" href="/dashboard/settings">Change number</Link></p>
      ) : (
        <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-200">Add a business phone number in <Link className="underline" href="/dashboard/settings">Settings</Link> to show this button.</p>
      )}
      {value.enabled ? (
        <>
          <AreaField id="wa-message" label="Pre-filled message" value={value.message} max={200} onChange={(message) => set({ message })} />
          <Choice id="wa-position" label="Position" value={value.position} onChange={(position) => set({ position })} options={[{ value: "right", label: "Bottom right" }, { value: "left", label: "Bottom left" }]} />
        </>
      ) : null}
    </div>
  );
}
