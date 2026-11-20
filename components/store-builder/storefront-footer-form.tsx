"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  DEFAULT_FOOTER_CONFIG,
  FOOTER_SECTION_KEYS,
  type FooterSectionKey,
  type FooterSocialNetwork,
  type StorefrontFooterConfig,
} from "@/modules/storefront/footer";

const SECTION_LABELS: Record<FooterSectionKey, string> = {
  brand: "Brand",
  shop: "Shop",
  support: "Customer support",
  policies: "Policies",
  business: "Business information",
  social: "Social icons",
  trust: "Trust / checkout",
  poweredBy: "Powered by Postbus",
};

const HEX = /^#[0-9A-Fa-f]{6}$/;

const SOCIAL_LABELS: Record<FooterSocialNetwork, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  x: "X / Twitter",
  linkedin: "LinkedIn",
};

function ColorField({
  id,
  label,
  value,
  fallback,
  disabled,
  onChange,
  onCommit,
}: {
  id: string;
  label: string;
  value: string | null;
  fallback: string;
  disabled: boolean;
  onChange: (value: string | null) => void;
  onCommit: (value: string | null) => void;
}) {
  const hex = value && HEX.test(value) ? value : fallback;
  const invalid = Boolean(value) && !HEX.test(value ?? "");
  return (
    <div className="min-w-0">
      <Label htmlFor={id}>{label}</Label>
      <div className="mt-1 flex min-w-0 gap-2">
        <input
          id={id}
          type="color"
          disabled={disabled}
          value={hex}
          aria-label={`${label} color picker`}
          className="h-11 w-11 shrink-0 cursor-pointer rounded-lg border border-border bg-card"
          onChange={(event) => onChange(event.target.value)}
          onBlur={(event) => onCommit(event.target.value)}
        />
        <Input
          id={`${id}-hex`}
          aria-label={`${label} hex`}
          aria-invalid={invalid || undefined}
          className={`h-11 min-w-0 font-mono uppercase ${invalid ? "border-red-500" : ""}`}
          disabled={disabled}
          maxLength={7}
          value={value ?? ""}
          placeholder={fallback}
          onChange={(event) => onChange(event.target.value.trim() || null)}
          onBlur={(event) => {
            const next = event.target.value.trim();
            // Empty resets to the default; anything else must be a full hex before it is saved.
            if (!next) onCommit(null);
            else if (HEX.test(next)) onCommit(next);
          }}
        />
      </div>
      {invalid ? <p className="mt-1 text-xs text-red-600">Use a hex color like #18181B.</p> : null}
    </div>
  );
}

export function StorefrontFooterForm({
  value,
  disabled,
  onChange,
  onCommit,
}: {
  value: StorefrontFooterConfig;
  disabled: boolean;
  onChange: (next: StorefrontFooterConfig) => void;
  onCommit: (next: StorefrontFooterConfig) => void;
}) {
  const footer = value ?? DEFAULT_FOOTER_CONFIG;

  function patch(next: StorefrontFooterConfig) {
    onChange(next);
  }

  function moveSocial(id: FooterSocialNetwork, direction: -1 | 1) {
    const order = [...footer.social.order];
    const from = order.indexOf(id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= order.length) return;
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    const next = { ...footer, social: { ...footer.social, order } };
    patch(next);
    onCommit(next);
  }

  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Footer</h3>
          <p className="mt-1 text-xs text-muted">
            Appearance only. Business, contact, and policies come from Dashboard Settings.
          </p>
        </div>
        <Switch
          aria-label="Show footer"
          checked={footer.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => {
            const next = { ...footer, enabled };
            patch(next);
            onCommit(next);
          }}
        />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="footer-layout">Layout</Label>
          <select
            id="footer-layout"
            disabled={disabled}
            className="mt-1 h-11 w-full min-w-0 rounded-xl border border-border bg-background px-3 text-sm"
            value={footer.layout}
            onChange={(event) => {
              const next = { ...footer, layout: event.target.value === "stacked" ? "stacked" : "columns" } as StorefrontFooterConfig;
              patch(next);
              onCommit(next);
            }}
          >
            <option value="columns">Multi-column</option>
            <option value="stacked">Stacked</option>
          </select>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <ColorField id="footer-bg" label="Background" value={footer.backgroundColor} fallback="#18181b" disabled={disabled} onChange={(backgroundColor) => patch({ ...footer, backgroundColor })} onCommit={(backgroundColor) => onCommit({ ...footer, backgroundColor })} />
        <ColorField id="footer-text" label="Text" value={footer.textColor} fallback="#d4d4d8" disabled={disabled} onChange={(textColor) => patch({ ...footer, textColor })} onCommit={(textColor) => onCommit({ ...footer, textColor })} />
        <ColorField id="footer-heading" label="Headings" value={footer.headingColor} fallback="#fafafa" disabled={disabled} onChange={(headingColor) => patch({ ...footer, headingColor })} onCommit={(headingColor) => onCommit({ ...footer, headingColor })} />
        <ColorField id="footer-accent" label="Accent" value={footer.accentColor} fallback="#E11D48" disabled={disabled} onChange={(accentColor) => patch({ ...footer, accentColor })} onCommit={(accentColor) => onCommit({ ...footer, accentColor })} />
        <ColorField id="footer-border" label="Border" value={footer.borderColor} fallback="#3f3f46" disabled={disabled} onChange={(borderColor) => patch({ ...footer, borderColor })} onCommit={(borderColor) => onCommit({ ...footer, borderColor })} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-xs text-muted">Colors save when you leave the field.</p>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            const next = { ...footer, backgroundColor: null, textColor: null, headingColor: null, accentColor: null, borderColor: null };
            patch(next);
            onCommit(next);
          }}
        >
          Reset colors
        </Button>
      </div>

      <div className="mt-5 space-y-2">
        <p className="text-sm font-semibold">Sections</p>
        {FOOTER_SECTION_KEYS.map((key) => (
          <label key={key} className="flex min-h-11 items-center justify-between gap-3 rounded-xl px-1 text-sm">
            <span className="min-w-0 truncate">{SECTION_LABELS[key]}</span>
            <Switch
              aria-label={`Show ${SECTION_LABELS[key]}`}
              checked={footer.sections[key]}
              disabled={disabled}
              onCheckedChange={(checked) => {
                const next = { ...footer, sections: { ...footer.sections, [key]: checked } };
                patch(next);
                onCommit(next);
              }}
            />
          </label>
        ))}
      </div>

      <div className="mt-5 space-y-3">
        <p className="text-sm font-semibold">Social links</p>
        {footer.social.order.map((id, index) => {
          const item = footer.social.items[id];
          return (
            <div key={id} className="rounded-xl border border-border p-3">
              <div className="flex min-h-11 items-center justify-between gap-2">
                <p className="text-sm font-medium">{SOCIAL_LABELS[id]}</p>
                <div className="flex items-center gap-1">
                  <Button type="button" size="icon-xs" variant="ghost" aria-label={`Move ${SOCIAL_LABELS[id]} up`} title="Move up" disabled={disabled || index === 0} onClick={() => moveSocial(id, -1)}>
                    <ArrowUp />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Move ${SOCIAL_LABELS[id]} down`}
                    title="Move down"
                    disabled={disabled || index === footer.social.order.length - 1}
                    onClick={() => moveSocial(id, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Switch
                    aria-label={`Show ${SOCIAL_LABELS[id]}`}
                    checked={item.enabled}
                    disabled={disabled}
                    onCheckedChange={(enabled) => {
                      const next = {
                        ...footer,
                        social: { ...footer.social, items: { ...footer.social.items, [id]: { ...item, enabled } } },
                      };
                      patch(next);
                      onCommit(next);
                    }}
                  />
                </div>
              </div>
              <Input
                className="mt-2 h-11 min-w-0"
                aria-label={`${SOCIAL_LABELS[id]} URL`}
                type="url"
                inputMode="url"
                disabled={disabled}
                placeholder={`https://${id}.com/...`}
                value={item.url}
                onChange={(event) => {
                  const next = {
                    ...footer,
                    social: { ...footer.social, items: { ...footer.social.items, [id]: { ...item, url: event.target.value } } },
                  };
                  patch(next);
                }}
                onBlur={(event) => {
                  const url = event.target.value.trim();
                  if (url && !/^https?:\/\//i.test(url)) {
                    toast.error(`${SOCIAL_LABELS[id]} link must start with https://`);
                    return;
                  }
                  const next = {
                    ...footer,
                    social: { ...footer.social, items: { ...footer.social.items, [id]: { ...item, url: event.target.value } } },
                  };
                  onCommit(next);
                }}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
