# PostBus Store Builder — Audit & Migration Plan

Status: **PLAN — awaiting approval. No code has been changed.**
Date: 2026-11-20 · Branch at audit time: `fix/auth-session-stability` · Next 16.4.6 / React 19.3

---

## 1. Audit — what exists today

### 1.1 Inventory page (`app/(site)/dashboard/inventory/page.tsx`)
Client page with `?tab=` tabs: `overview · products · categories · covers · storefront · coupons`.
Write access = `hasPermission(role, "products.write")`. No plan/entitlement gate on Inventory or storefront.

### 1.2 Everything under Inventory → Storefront (`storefront-panel.tsx`, 1,085 lines)
| Block | Persists to | Notes |
|---|---|---|
| Header: logo, Live/Hidden badge, copy link, WhatsApp share, View store | — | |
| Setup checklist (6 items, progress bar, jump-to) | derived | |
| Store details: name, store address (`StoreAddressField` — path slug + `{slug}.postbus.in`), Store visible toggle + hide confirm | `storefront_settings`, `customer_order_links` | address change = OWNER/ADMIN |
| Branding: logo upload, accent colour (8 presets + hex), `ThemeSettings` (secondary colour, font geist/inter/manrope) | `storefront_settings.logo_path / accent_color / theme jsonb` | |
| Featured products (max 24, reorder, prune hidden) | `storefront_settings.featured_product_ids uuid[]` | reads live `products` |
| Homepage covers summary + autoplay | `storefront_slides`, `cover_autoplay` | full editing is Cover Studio (`/dashboard/inventory/covers/[id]`) |
| Product bundles (`MarketplaceBundles`) | `storefront_bundles`, `storefront_bundle_items` | |
| Footer & social (`StorefrontFooterForm`) | `storefront_settings.footer jsonb` | WhatsApp link auto-derived from org phone |
| SEO title/description + search preview | `storefront_settings` seo cols | |
| WhatsApp order payments: UPI ID, GPay no., QR | `storefront_settings` upi/gpay/qr | |
| Analytics & tracking pixels (Meta, GA4, Clarity, GTM) | `storefront_settings.tracking jsonb` | DB trigger: OWNER/ADMIN only |
| Live preview: iPhone / Android / Desktop iframe | — | `/store-preview` + `postMessage` (`modules/storefront/preview.ts`) |

**Critical behaviour:** every field **autosaves straight to the live store** (`PATCH /api/v1/inventory/storefront`). There is no draft, publish, or restore layer today.

### 1.3 Related tabs/pages that are storefront-specific
- **Covers** tab + Cover Studio (`/dashboard/inventory/covers/[id]`) — covers already have their own lifecycle (draft / scheduled / live / expired / archived) and analytics.
- **Coupons** tab (`coupons-panel.tsx`, `coupon-editor.tsx`) — `storefront_coupons`, redemptions, `?discount=` magic links.
- **Categories** tab — `product_categories` are shared by inventory and the store (they work as the store's collections).

### 1.4 Public storefront
- Routes: `/store/[workspace]`, `/category/[slug]`, `/products/[slug]`, `/[policy]`; subdomain `{slug}.postbus.in` via `proxy.ts` + `modules/storefront/host*.ts` (behind `STOREFRONT_SUBDOMAINS_ENABLED`).
- Loader: `modules/storefront/public.ts → loadPublicStorefront` reads `storefront_settings` columns directly.
- Two renderers in `components/storefront/store-app.tsx`:
  - **Classic** `StoreHome` (default)
  - **Marketplace** `MarketplaceHome` (when `STOREFRONT_MARKETPLACE_ENABLED=true`): intro → search → category nav → cover banner → promises → shop-by-category → featured → bundles → best sellers → catalog. **Section order is hard-coded.**
- Theme = only accent + secondary colour + font. No theme catalogue, no section config.

### 1.5 Commerce already built (reuse, don't duplicate)
| Capability | Where |
|---|---|
| Products / stock | `products`, `inventory_balances`, `modules/products` |
| Upsell / cross-sell | `modules/storefront/recommendations.ts` |
| Bundles | `modules/storefront/bundles.ts`, `bundle-pricing.ts` |
| Coupons + auto-apply | `modules/storefront/coupons/*` |
| Fast checkout + WhatsApp OTP + saved buyer addresses | `fast-checkout.tsx`, `modules/storefront/buyer*.ts`, `storefront_buyer_addresses/devices/checkout_otps`; OTP template in Admin → VaChat |
| COD / prepaid / partial (advance) | per product: `cod_enabled`, `prepaid_enabled`, `cod_advance_percent`; quote in `modules/storefront/quote.ts` |
| Razorpay / Cashfree (merchant) | `modules/merchant-payments/*`, pages `/dashboard/integrations/{razorpay,cashfree}`, `PaymentGatewayDefault` component |
| Orders → shipping → India Post booking | `modules/orders`, `modules/storefront/order-notify.ts`, booking queue |
| Policies (privacy/terms/shipping/returns) | `/dashboard/settings` → `PoliciesSettings` |
| Analytics | `storefront_events` (PRODUCT_VIEW → PURCHASE funnel), cover impression/click analytics, inventory overview RPC |

### 1.6 Navigation & permissions
- Sidebar source of truth: `lib/dashboard/nav.ts` (`sidebarNav`); plan locks via `modules/billing/entitlements.ts → NAV_FEATURES`.
- API: `lib/api/v1/inventory.ts` handles `inventory/storefront*`; permission mapping in `permissionForTenantRoute` (tested in `lib/api/v1-permissions.test.ts`) — read = `products.read`, write = `products.write`.
- RLS: `is_org_member(org)` for select, `inventory_writer(org)` for write; tracking guarded by trigger.
- Only in-app links to storefront tab: inside the storefront panel itself (to `?tab=categories/covers/products`). Cover Studio links back to `?tab=covers`.

### 1.7 Gaps vs. the brief
| Requirement | Status |
|---|---|
| **"Existing 20 business categories"** | **Not found anywhere in the code or DB.** Only a regex helper `suggestedPresetForCategory` in `modules/ai-image/presets.ts`. Organisations don't store a business category. → needs a decision (§5, Q1). |
| Theme marketplace / install | Missing |
| Draft / publish / restore | Missing (everything is live) |
| Section reorder / visibility | Missing (hard-coded order) |
| Video shopping, testimonials, promo banners, announcement bar, nav menu, floating WhatsApp button | Missing |
| Custom domains | Missing (path + `{slug}.postbus.in` only) |
| Custom content pages | Missing (policy pages only) |
| Storefront analytics dashboard | Data exists, no funnel view |

### 1.8 Repo state warning
The storefront files on this branch have **~1,400 lines of uncommitted changes** (`storefront-panel.tsx`, `marketplace-settings.tsx`, `store-app.tsx`, `fast-checkout.tsx`, `modules/storefront/service.ts`, …) plus unrelated uncommitted work across the repo. These must be committed or isolated before the refactor (§5, Q4).

---

## 2. Target architecture

### 2.1 Routes
```
/dashboard/store-builder                 Overview (setup progress, status, quick links, KPIs)
/dashboard/store-builder/themes          Theme Marketplace
/dashboard/store-builder/customize       Visual editor (full-width, sticky Save draft / Publish)
/dashboard/store-builder/products        Products & Collections (embeds existing categories manager,
                                          featured picks, bundles; links into Inventory → Products)
/dashboard/store-builder/pages           Pages & Navigation (menu editor, policy pages)
/dashboard/store-builder/domains         Domains & Subdomains (existing StoreAddressField)
/dashboard/store-builder/checkout        Checkout settings (fast checkout/OTP, COD/advance summary)
/dashboard/store-builder/payments        Payment Integrations (PaymentGatewayDefault, Razorpay/Cashfree
                                          status, UPI/GPay/QR)
/dashboard/store-builder/marketing       Coupons, covers, SEO & sharing, tracking pixels
/dashboard/store-builder/analytics       Funnel + cover performance + top products
/dashboard/store-builder/settings        Visibility, store name, logo, danger zone
```
Shared `layout.tsx` with a responsive section nav (left rail on desktop, scrollable tabs on mobile).

### 2.2 Sidebar & redirect
- Add `{ label: "Store Builder", href: "/dashboard/store-builder", icon: Store }` right after Inventory in `lib/dashboard/nav.ts`; breadcrumb label.
- `/dashboard/inventory?tab=storefront` → `/dashboard/store-builder/customize` (server redirect via `next.config` `has: [{type:"query", key:"tab", value:"storefront"}]`, with a client fallback in the inventory page). Check the Next 16 redirect docs in `node_modules/next/dist/docs/` first.
- Remove the Storefront tab from Inventory. Overview / Products / Categories stay in Inventory unchanged.
- Covers & Coupons: see §5, Q3.

### 2.3 Data model (one additive migration, nothing dropped)
```sql
alter table storefront_settings
  add column theme_id          text,             -- installed theme (null = legacy look)
  add column business_category text,             -- drives recommendations
  add column draft_layout      jsonb,            -- editor working copy
  add column published_layout  jsonb,            -- what the live store renders
  add column draft_updated_at  timestamptz,
  add column published_at      timestamptz;

create table storefront_layout_versions (        -- publish history for restore
  id uuid pk, organization_id uuid fk → organizations on delete cascade,
  snapshot jsonb not null,                       -- layout + branding columns at publish time
  published_by uuid, published_at timestamptz default now()
);  -- RLS: select is_org_member, write only through RPC; keep last 20 per org

function publish_storefront_draft(p_org uuid)    -- security definer, checks inventory_writer
  -- 1. snapshot current live state into storefront_layout_versions
  -- 2. copy draft branding into the EXISTING columns (store_name, accent_color, theme,
  --    footer, featured_product_ids, logo_path) so every current reader keeps working
  -- 3. published_layout := draft_layout, published_at := now()   (one transaction)
function restore_storefront_version(p_org uuid, p_version uuid)  -- copies snapshot → draft (not live)
```
**Why this shape:** the public loader and checkout keep reading the same columns they read today. Only the new `published_layout` is read in addition. With `published_layout` null, the store renders exactly as it does now, so existing stores are unaffected until the merchant publishes.

### 2.4 What goes through draft vs. stays immediate
| Draft → Publish | Immediate (operational, as today) |
|---|---|
| Theme, colours, fonts, logo, store name, header/nav, sections & order & visibility, hero, promos, video, testimonials, featured picks, footer, WhatsApp button | Store visible, store address/subdomain, payments (UPI/QR, gateways), tracking pixels, SEO, coupons, bundles (data), covers (own lifecycle), product data |

### 2.5 Layout config (zod, `modules/storefront/layout/schema.ts`)
```ts
{ version: 1,
  themeId: string,
  tokens: { accent, secondary, font, radius, cardStyle, headerStyle, buttonStyle },
  header: { announcement?: {text, href, enabled}, menu: NavLink[] /* category | policy | url */ },
  sections: Array<{ id, type, visible, settings }>,   // max 30
  whatsappButton: { enabled, position, message } }
```
Section types → reusable components in `components/storefront/sections/`:
`hero` (uses covers) · `category_grid` · `featured_products` · `collection` (a product_category) · `product_grid` · `promo_banner` · `video_shopping` (YouTube/MP4 URL + linked product ids) · `bundles` (existing) · `upsell` (existing recommendations) · `best_sellers` · `testimonials` · `trust_badges` (existing "promises") · `rich_text` · `catalog` (required, always last-or-fixed).
Section content only **references** product/category ids. It never copies product data. Missing or hidden products are filtered at render time, as featured picks are today.

### 2.6 Themes (`modules/storefront/themes/`)
- A code-defined registry: no DB rows and no dependencies. Each theme has an `id`, a name, a description, `recommendedFor: BusinessCategory[]`, default tokens, a default section stack, and a preview thumbnail.
- Visual differences come from CSS variables plus `data-theme` variant classes in `marketplace.module.css`, for example header layout, card shape, typography scale, and hero style.
- **Install** = write `themeId` + tokens into the **draft**. Existing section content is merged by type. Nothing is deleted: products, covers, coupons, and bundles live in their own tables.
- Default theme "Classic" reproduces today's marketplace home 1:1, so it can be migrated with zero visual change.
- Recommended starting set: about 8–10 themes mapped across the 20 categories. More can be added later as config.

### 2.7 Editor (`/customize`)
- Left panel: section list with drag handles, keyboard up/down, eye toggle, and add/remove; settings form for the selected section; global tab (brand, header, footer, WhatsApp).
- Right: the **existing** `/store-preview` iframe plus `postMessage`, extended so `StorePayload` carries `layout`. Desktop and mobile toggles already exist.
- Sticky bar: draft status · **Save draft** (debounced autosave to `draft_layout`) · **Publish** (confirm dialog with a diff summary) · **Discard draft** · **History → Restore**.
- Renderer: `MarketplaceHome` becomes a section-map loop over `layout.sections`. When there is no layout, the same default stack is used.

### 2.8 API (additive; existing endpoints unchanged)
```
GET   inventory/storefront/draft          products.read
PATCH inventory/storefront/draft          products.write
POST  inventory/storefront/publish        products.write   (see Q5)
POST  inventory/storefront/draft/discard  products.write
GET   inventory/storefront/versions       products.read
POST  inventory/storefront/versions/:id/restore  products.write  (→ draft)
GET   inventory/storefront/analytics      products.read    (funnel from storefront_events)
GET   inventory/storefront/themes         products.read    (registry + recommendations)
```
All are added to `permissionForTenantRoute` with tests. Tenant scoping always comes from `ctx.organizationId` and never from the request body.

### 2.9 Reuse map (no logic duplication)
| Store Builder page | Reuses |
|---|---|
| Overview | checklist logic lifted from `storefront-panel.tsx` |
| Products & Collections | `InventoryCategoriesManager`, featured-picks block, `MarketplaceBundles`; deep links to Inventory → Products |
| Domains | `StoreAddressField` |
| Checkout | read-only summary + links: per-product COD/advance, fast checkout/OTP status |
| Payments | `PaymentGatewayDefault`, Razorpay/Cashfree integration status, UPI/QR `AssetField` |
| Marketing | `InventoryCoupons`, covers list + Cover Studio, SEO block, `TrackingSettings` |
| Analytics | `storefront_events` + existing cover analytics endpoint |
| Pages & Navigation | `PoliciesSettings` (moved or linked), new menu editor |

`storefront-panel.tsx` is split into these smaller components (moved, not rewritten), so the 1,085-line file goes away.

---

## 3. Phased delivery (each phase shippable on its own)

| # | Phase | Changes | Risk |
|---|---|---|---|
| 0 | Prep | Commit or isolate the current uncommitted storefront work; branch `feat/store-builder` | — |
| 1 | **Route + move** | `/dashboard/store-builder/*` shell, sidebar item, redirect, split the existing panel into pages. **Behaviour identical** (still autosave-live) | Low |
| 2 | **Sections renderer** | Layout schema, theme registry with "Classic" only, `MarketplaceHome` → section loop. With no layout = today's output (snapshot test) | Medium (public store) |
| 3 | **Draft / Publish / Restore** | Migration + RPCs + API + editor sticky bar; branding fields move behind the draft | Medium (DB) |
| 4 | **Theme Marketplace** | 8–10 themes, category recommendations, install-to-draft, desktop/mobile previews | Low |
| 5 | **New sections** | announcement, menu, promo banner, video shopping, testimonials, rich text, WhatsApp float, collection | Low |
| 6 | **Ops pages** | checkout, payments, marketing, analytics funnel, settings | Low |
| 7 | **Verification** | full test pass + browser QA on staging | — |

Decision for the classic renderer (non-marketplace): it stays as is, and the builder targets the marketplace renderer (see Q2).

---

## 4. Test plan
- **Unit (vitest):** layout schema (limits, unknown types dropped), theme registry (every theme parses, every category maps to ≥1 theme), install-merge never drops section content, publish snapshot/restore round-trip, nav permissions for the new routes, `lockedFeatureForPath` unaffected.
- **PG (PGlite) tests:** migration applies on top of the current schema; RLS: org A can't read or write org B's draft, versions, or analytics; `publish_storefront_draft` rejects non-writers; tracking trigger still enforced; publishing doesn't touch products, coupons, covers, or bundles.
- **Regression:** existing `modules/storefront/*.test.ts`, `merchant-payments` isolation and pg tests, `host*.test.ts`, `proxy*.test.ts`, coupons, fast checkout, order-create, stock-commit.
- **Renderer snapshot:** a store with `published_layout = null` renders identically before and after Phase 2.
- **Browser QA on staging only** (local Supabase via `.env.staging.local`, never prod :3000): Inventory tabs still work; the old `?tab=storefront` link redirects; editing the draft doesn't change the live `/store/{slug}` until Publish; Restore works; theme switch keeps products, covers, and coupons; subdomain and path both serve; checkout with COD, Razorpay test, and Cashfree test; order → shipping/booking flow unchanged; mobile 375px layout of every builder page.

---

## 5. Decisions needed before implementation
1. **20 business categories:** none exist in the code. Should I (a) use the list below and store it as `storefront_settings.business_category`, or (b) use a list you provide?
   Proposed: Fashion & Apparel · Sarees & Ethnic Wear · Jewellery & Accessories · Beauty & Cosmetics · Skincare & Ayurveda · Health & Wellness · Food & Snacks · Spices & Groceries · Home Decor · Kitchen & Dining · Furniture · Electronics & Gadgets · Mobile Accessories · Books & Stationery · Toys & Kids · Baby Care · Handicrafts & Art · Gifts & Festive · Pet Supplies · Sports & Fitness.
2. **Marketplace flag:** sections and themes need the marketplace renderer. Is `STOREFRONT_MARKETPLACE_ENABLED` on in production? Should Store Builder theming turn it on per store (recommended: a per-store switch, so the env flag becomes the default only)?
3. **Covers & Coupons tabs:** move them out of Inventory into Store Builder → Marketing (with redirects), or keep them in both places? Recommended: move them, with redirects. Cover Studio URLs `/dashboard/inventory/covers/[id]` keep working.
4. **Uncommitted work:** commit the current storefront and checkout changes on this branch first, or start `feat/store-builder` from a clean point?
5. **Publish permission:** keep `products.write` (same as today's live autosave), or restrict Publish to OWNER/ADMIN?
6. **Out of scope for now (confirm):** custom domains (need Coolify/SSL work), free-form custom content pages beyond policies, drag-and-drop canvas editing inside the preview. The editor is form + list driven with a live preview.
