import { withPostHogProxy } from "@posthog/next";
import { NextResponse, type NextRequest } from "next/server";
import { processServerErrorTrackingEnabled, requestPathname } from "@/lib/analytics/posthog-shared";
import { applySecurityHeaders } from "@/lib/security/headers";
import { updateSession } from "@/lib/supabase/proxy";
import { parseTrackingSubdomain } from "@/modules/tracking-pages/host";
import {
  STORE_HOST_HEADER,
  isAppOnlyPath,
  legacyStoreRedirectTarget,
  parseLegacyStorePath,
  storeHostInternalPath,
  storeSubdomainsEnabled,
} from "@/modules/storefront/host";
import { resolveStoreHost, type ResolvedStoreHost } from "@/modules/storefront/host-resolver";

const TRACKING_HEADER = "x-tracking-subdomain";

function secured(response: NextResponse, pathname?: string, shop?: string | null) {
  applySecurityHeaders(response.headers, { pathname, shop });
  return response;
}

function requestHostname(hostHeader: string | null) {
  return hostHeader?.split(":")[0]?.toLowerCase() ?? "";
}

function shouldRewriteToTrack(pathname: string) {
  return (
    !pathname.startsWith("/api/") &&
    !pathname.startsWith("/_next/") &&
    pathname !== "/track" &&
    !pathname.startsWith("/track/")
  );
}

function isTrackPath(pathname: string) {
  return pathname === "/track" || pathname.startsWith("/track/");
}

/** Host routing headers are set only by this proxy; never trust a client-sent copy. */
function cleanHeaders(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete(STORE_HOST_HEADER);
  headers.delete(TRACKING_HEADER);
  return headers;
}

function appOrigin() {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "https://www.postbus.in").replace(/\/$/, "");
}

/** `{slug}.postbus.in`: the store at `/`, its pages under it, the same merchant's tracking page at `/track`. */
function storeHostResponse(request: NextRequest, label: string, store: ResolvedStoreHost) {
  const { pathname, search } = request.nextUrl;

  // Dashboard, login and the rest of the app stay on the PostBus host (auth cookies are host-only there).
  if (isAppOnlyPath(pathname)) {
    return secured(NextResponse.redirect(`${appOrigin()}${pathname}${search}`, 308), pathname);
  }

  // Old in-app links (`/store/{slug}/…`) and saved cover CTAs: move to the clean host path.
  const legacy = parseLegacyStorePath(pathname);
  if (legacy) {
    if (legacy.workspace === store.workspace) {
      // Built from the Host header: behind a proxy nextUrl can carry the upstream host instead.
      const host = request.headers.get("host") ?? request.nextUrl.host;
      return secured(NextResponse.redirect(`${request.nextUrl.protocol}//${host}${legacy.rest || "/"}${search}`, 308), pathname);
    }
    const target = legacyStoreRedirectTarget(pathname, search);
    if (target) return secured(NextResponse.redirect(target, 308), pathname);
  }

  const headers = cleanHeaders(request);
  headers.set(STORE_HOST_HEADER, store.workspace);
  if (store.hasTrackingPage) headers.set(TRACKING_HEADER, label);

  if (pathname.startsWith("/api/") || pathname.startsWith("/_next/")) {
    return secured(NextResponse.next({ request: { headers } }), pathname);
  }

  const rewriteUrl = request.nextUrl.clone();
  if (isTrackPath(pathname)) {
    rewriteUrl.pathname = "/track";
  } else if (pathname === "/" && store.hasTrackingPage && request.nextUrl.searchParams.has("tracking")) {
    // Tracking links already sent to customers were `https://{slug}.postbus.in/?tracking=…`.
    rewriteUrl.pathname = "/track";
  } else {
    rewriteUrl.pathname = storeHostInternalPath(pathname, store.workspace);
  }
  return secured(NextResponse.rewrite(rewriteUrl, { request: { headers } }), pathname);
}

async function handleProxy(request: NextRequest) {
  const hostHeader = request.headers.get("host");
  const canonicalHost = requestHostname(hostHeader) || request.nextUrl.hostname.toLowerCase();
  const subdomain = parseTrackingSubdomain(hostHeader);
  const subdomainStores = storeSubdomainsEnabled();

  // Old public store URLs move permanently to the merchant subdomain, subpath and query kept.
  if (!subdomain && subdomainStores) {
    const legacy = parseLegacyStorePath(request.nextUrl.pathname);
    if (legacy && (await resolveStoreHost(legacy.workspace))) {
      const target = legacyStoreRedirectTarget(request.nextUrl.pathname, request.nextUrl.search);
      if (target) return secured(NextResponse.redirect(target, 301), request.nextUrl.pathname);
    }
  }

  // Keep auth cookies on one host so confirmation links do not lose the session.
  if (canonicalHost === "postbus.in") {
    const url = request.nextUrl.clone();
    url.protocol = "https:";
    url.hostname = "www.postbus.in";
    url.port = "";
    return secured(NextResponse.redirect(url, 308), request.nextUrl.pathname);
  }

  if (subdomain) {
    if (subdomainStores) {
      const store = await resolveStoreHost(subdomain);
      if (store) return storeHostResponse(request, subdomain, store);
    }

    const extraHeaders = cleanHeaders(request);
    extraHeaders.set(TRACKING_HEADER, subdomain);
    if (shouldRewriteToTrack(request.nextUrl.pathname)) {
      const rewriteUrl = request.nextUrl.clone();
      rewriteUrl.pathname = "/track";
      return secured(await updateSession(request, { extraHeaders, rewriteUrl }), request.nextUrl.pathname);
    }
    return secured(await updateSession(request, { extraHeaders }), request.nextUrl.pathname);
  }

  if (process.env.POSTBUS_AFFILIATES_ENABLED === "true" && request.nextUrl.pathname === "/" && request.nextUrl.searchParams.has("ref")) {
    const url = request.nextUrl.clone();
    url.pathname = "/api/affiliate-referral";
    return secured(NextResponse.redirect(url), request.nextUrl.pathname);
  }
  return secured(
    await updateSession(request, { extraHeaders: cleanHeaders(request) }),
    request.nextUrl.pathname,
    request.nextUrl.searchParams.get("shop")
  );
}

export const proxy = withPostHogProxy(handleProxy, {
  apiKey: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  beforeCapture: ({ request }) => {
    if (!processServerErrorTrackingEnabled(requestPathname(request.path ?? "/"))) return false;
  },
});

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|_next/hmr|_next/webpack-hmr|favicon.ico|robots.txt|sitemap.xml|manifest.webmanifest|opengraph-image|twitter-image|icon|apple-icon|src/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
