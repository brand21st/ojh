"use client";

import { createContext, useCallback, useContext, type ReactNode } from "react";

/**
 * Store links are written as `/store/{slug}/…` throughout the storefront (and saved that way in
 * covers and footers). On the merchant's own host `{slug}.postbus.in` the base is `""`, so those
 * links are rebased to `/…`. Without a provider (dashboard preview, legacy path) links stay as-is.
 */
const StoreBaseContext = createContext<{ workspace: string; basePath: string } | null>(null);

export function StoreBaseProvider({
  workspace,
  basePath,
  children,
}: {
  workspace: string;
  basePath: string | undefined;
  children: ReactNode;
}) {
  if (basePath === undefined || !workspace) return <>{children}</>;
  return <StoreBaseContext.Provider value={{ workspace: workspace.toLowerCase(), basePath }}>{children}</StoreBaseContext.Provider>;
}

/** Pure rebase used by the hook; exported for tests. */
export function rebaseStoreHref(href: string, workspace: string, basePath: string) {
  const prefix = `/store/${workspace}`;
  if (href !== prefix && !href.startsWith(`${prefix}/`) && !href.startsWith(`${prefix}?`) && !href.startsWith(`${prefix}#`)) {
    return href;
  }
  const rest = href.slice(prefix.length);
  const next = `${basePath}${rest}`;
  if (!next || next.startsWith("?") || next.startsWith("#")) return `/${next}`;
  return next;
}

/** `(href) => href` rebased for the current host. */
export function useStoreHref() {
  const ctx = useContext(StoreBaseContext);
  return useCallback(
    (href: string) => (ctx ? rebaseStoreHref(href, ctx.workspace, ctx.basePath) : href),
    [ctx]
  );
}

/** True when this page is served on the merchant's own subdomain. */
export function useOnStoreHost() {
  return useContext(StoreBaseContext)?.basePath === "";
}
