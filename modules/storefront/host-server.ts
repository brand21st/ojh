import { headers } from "next/headers";
import { env } from "@/lib/env";
import { STORE_HOST_HEADER, storeBasePath, storePublicUrl } from "./host";

/** Link base for this request: `""` when served on `{slug}.postbus.in`, `/store/{slug}` otherwise. */
export async function storeRequestBasePath(workspace: string) {
  const host = (await headers()).get(STORE_HOST_HEADER);
  return storeBasePath(workspace, host === workspace.toLowerCase());
}

/** Absolute canonical URL: the subdomain once live, otherwise the legacy path on the PostBus host. */
export function storeCanonicalUrl(workspace: string, subpath = "") {
  return storePublicUrl(workspace.toLowerCase(), subpath, env.appUrl);
}
