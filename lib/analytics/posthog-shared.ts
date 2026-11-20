export const POSTHOG_DEFAULT_HOST = "https://us.i.posthog.com";

export function isShopifyEmbeddedPath(pathname: string): boolean {
  return pathname === "/shopify" || pathname.startsWith("/shopify/");
}

export function requestPathname(path: string): string {
  return path.split("?")[0] || "/";
}

export type ServerErrorTrackingEnv = {
  token: string | undefined;
  host: string | undefined;
  nodeEnv: string | undefined;
  runtime: string | undefined;
  pathname: string;
};

export type ServerErrorTrackingDecision =
  | { enabled: true }
  | { enabled: false; reason: "no-token" | "local-dev" | "shopify-embedded" };

/** Same privacy gates as the browser SDK: no token, local `next dev`, Shopify Admin. */
export function serverErrorTrackingDecision(env: ServerErrorTrackingEnv): ServerErrorTrackingDecision {
  if (!env.token?.trim()) return { enabled: false, reason: "no-token" };
  if (env.nodeEnv !== "production") return { enabled: false, reason: "local-dev" };
  const pathname = requestPathname(env.pathname);
  if (isShopifyEmbeddedPath(pathname)) return { enabled: false, reason: "shopify-embedded" };
  return { enabled: true };
}

export function processServerErrorTrackingEnabled(pathname = "/"): boolean {
  return serverErrorTrackingDecision({
    token: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    nodeEnv: process.env.NODE_ENV,
    runtime: process.env.NEXT_RUNTIME,
    pathname,
  }).enabled;
}
