import { RESERVED_SUBDOMAINS } from "@/modules/tracking-pages/constants";
import { trackingPagePublicUrl, trackingHostSuffix } from "@/modules/tracking-pages/host";

/**
 * Merchant storefronts on `{slug}.postbus.in`.
 *
 * Store slugs and tracking-page subdomains share one host namespace. A host whose label is an
 * active store slug serves that store at `/`; the same merchant's tracking page (if any) is at
 * `/track`. Hosts that are not a store keep the tracking-page behaviour.
 */

/** Request header the proxy sets on store-host requests. Pages read it to build host-relative links. */
export const STORE_HOST_HEADER = "x-store-host";

/**
 * Names a merchant can never claim for a new store. Infra hosts (RESERVED_SUBDOMAINS) are also
 * refused by host parsing; the rest are reserved for future PostBus use but grandfathered if an
 * existing store already has one.
 */
export const RESERVED_STORE_SUBDOMAINS = [
  ...RESERVED_SUBDOMAINS,
  "about", "abuse", "account", "accounts", "affiliate", "affiliates", "analytics", "assets", "beta", "billing",
  "blog", "careers", "cart", "checkout", "cod", "community", "contact", "coolify", "cp", "demo", "dev", "docs",
  "edge", "email", "files", "forum", "ftp", "gateway", "go", "grafana", "help", "hostmaster", "id", "images", "img",
  "imap", "india-post", "indiapost", "internal", "invoice", "invoices", "legal", "link", "links", "login", "m",
  "media", "metrics", "mobile", "monitoring", "mx", "my", "new", "news", "ns1", "ns2", "oauth", "order", "orders",
  "origin", "panel", "partner", "partners", "pay", "payments", "pop", "portal", "postmaster", "preview", "press",
  "privacy", "proxy", "qr", "register", "root", "sandbox", "secure", "security", "sentry", "server", "settings",
  "shop", "shopify", "short", "signup", "smtp", "sso", "staging", "store", "stores", "support", "system", "terms",
  "test", "track", "tracking", "traefik", "url", "vachat", "webhook", "webhooks", "webmail", "webmaster",
  "whatsapp", "ws",
] as const;

const RESERVED_SET = new Set<string>(RESERVED_STORE_SUBDOMAINS);

export function isReservedStoreSubdomain(slug: string) {
  return RESERVED_SET.has(slug.trim().toLowerCase());
}

/** DNS-safe store label: 3-48 chars, lowercase letters, digits, single inner hyphens. */
export const STORE_SUBDOMAIN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isStoreLabel(value: string) {
  return value.length >= 1 && value.length <= 48 && STORE_SUBDOMAIN_PATTERN.test(value);
}

/** The live switch. Off: path URLs only, no redirects, no host routing for stores. */
export function storeSubdomainsEnabled() {
  return (process.env.STOREFRONT_SUBDOMAINS_ENABLED ?? "").trim().toLowerCase() === "true";
}

/** `https://{slug}.postbus.in` (or `http://{slug}.localhost:3000` in dev). */
export function storeSubdomainUrl(slug: string) {
  return trackingPagePublicUrl(slug);
}

/** `.postbus.in`, shown after the slug input. */
export function storeSubdomainSuffix() {
  return trackingHostSuffix();
}

/** Public URL of a store page: the subdomain when live, else the legacy `/store/{slug}` path. */
export function storePublicUrl(slug: string, subpath = "", appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "") {
  const sub = subpath && !subpath.startsWith("/") && !subpath.startsWith("?") ? `/${subpath}` : subpath;
  if (storeSubdomainsEnabled()) return `${storeSubdomainUrl(slug)}${sub}`;
  return `${appUrl.replace(/\/$/, "")}/store/${slug}${sub}`;
}

/** Paths that belong to the PostBus app, never to a merchant host. */
const APP_ONLY_PREFIXES = [
  "/dashboard", "/admin", "/login", "/register", "/forgot-password", "/reset-password", "/onboarding",
  "/partner", "/auth", "/shopify", "/store-preview", "/dev",
];

export function isAppOnlyPath(pathname: string) {
  return APP_ONLY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** `/store/{slug}/rest` → `{ workspace, rest }`; null for anything else. */
export function parseLegacyStorePath(pathname: string): { workspace: string; rest: string } | null {
  const match = /^\/store\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!match) return null;
  const workspace = decodeURIComponent(match[1]).toLowerCase();
  if (!isStoreLabel(workspace)) return null;
  const rest = match[2] && match[2] !== "/" ? match[2].replace(/\/+$/, "") : "";
  return { workspace, rest };
}

/** Where the legacy path should permanently move: the merchant subdomain with the same subpath and query. */
export function legacyStoreRedirectTarget(pathname: string, search: string): string | null {
  const parsed = parseLegacyStorePath(pathname);
  if (!parsed) return null;
  if ((RESERVED_SUBDOMAINS as readonly string[]).includes(parsed.workspace)) return null;
  return `${storeSubdomainUrl(parsed.workspace)}${parsed.rest || "/"}${search}`;
}

/** Host path → the internal route that renders it, e.g. `/products/x` → `/store/{slug}/products/x`. */
export function storeHostInternalPath(pathname: string, workspace: string) {
  const clean = pathname === "/" ? "" : pathname.replace(/\/+$/, "");
  return `/store/${workspace}${clean}`;
}

/** Link base for store pages: `""` on the merchant host, `/store/{slug}` on the PostBus host. */
export function storeBasePath(workspace: string, onStoreHost: boolean) {
  return onStoreHost ? "" : `/store/${workspace}`;
}
