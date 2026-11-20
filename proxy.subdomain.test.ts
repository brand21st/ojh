import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/supabase/proxy", () => ({
  updateSession: async (_request: NextRequest, options?: { extraHeaders?: Headers; rewriteUrl?: URL }) => {
    const response = options?.rewriteUrl
      ? NextResponse.rewrite(options.rewriteUrl, { request: { headers: options.extraHeaders } })
      : NextResponse.next({ request: { headers: options?.extraHeaders } });
    return response;
  },
}));

const stores: Record<string, { workspace: string; organizationId: string; hasTrackingPage: boolean }> = {
  kala: { workspace: "kala", organizationId: "org-kala", hasTrackingPage: true },
  priya: { workspace: "priya", organizationId: "org-priya", hasTrackingPage: false },
};
vi.mock("@/modules/storefront/host-resolver", () => ({
  resolveStoreHost: async (label: string) => stores[label] ?? null,
}));

import { proxy } from "@/proxy";

function request(url: string, headers: Record<string, string> = {}) {
  const req = new NextRequest(url, { headers });
  req.headers.set("host", new URL(url).host);
  return req;
}
const rewriteOf = (response: Response) => response.headers.get("x-middleware-rewrite");
const forwarded = (response: Response, name: string) => response.headers.get(`x-middleware-request-${name}`);

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.postbus.in");
  vi.stubEnv("STOREFRONT_SUBDOMAINS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("merchant subdomain routing", () => {
  it("serves the store home and pages from {slug}.postbus.in", async () => {
    const home = await proxy(request("https://kala.postbus.in/"));
    expect(rewriteOf(home)).toBe("https://kala.postbus.in/store/kala");
    expect(forwarded(home, "x-store-host")).toBe("kala");
    const product = await proxy(request("https://kala.postbus.in/products/mug?ref=ig"));
    expect(rewriteOf(product)).toBe("https://kala.postbus.in/store/kala/products/mug?ref=ig");
  });

  it("keeps API calls as-is but tags them with the store host", async () => {
    const response = await proxy(request("https://kala.postbus.in/api/v1/public/store?workspace=kala"));
    expect(rewriteOf(response)).toBeNull();
    expect(forwarded(response, "x-store-host")).toBe("kala");
  });

  it("serves the same merchant's tracking page at /track and old ?tracking= links", async () => {
    const track = await proxy(request("https://kala.postbus.in/track"));
    expect(rewriteOf(track)).toBe("https://kala.postbus.in/track");
    expect(forwarded(track, "x-tracking-subdomain")).toBe("kala");
    const old = await proxy(request("https://kala.postbus.in/?tracking=EE123456789IN"));
    expect(rewriteOf(old)).toBe("https://kala.postbus.in/track?tracking=EE123456789IN");
  });

  it("never exposes a tracking page the store's merchant does not own", async () => {
    const track = await proxy(request("https://priya.postbus.in/track"));
    expect(forwarded(track, "x-tracking-subdomain")).toBeNull();
    const home = await proxy(request("https://priya.postbus.in/?tracking=X"));
    expect(rewriteOf(home)).toBe("https://priya.postbus.in/store/priya?tracking=X");
  });

  it("drops spoofed routing headers", async () => {
    const response = await proxy(request("https://priya.postbus.in/", { "x-store-host": "kala", "x-tracking-subdomain": "kala" }));
    expect(forwarded(response, "x-store-host")).toBe("priya");
    expect(forwarded(response, "x-tracking-subdomain")).toBeNull();
    const apex = await proxy(request("https://www.postbus.in/pricing", { "x-store-host": "kala" }));
    expect(forwarded(apex, "x-store-host")).toBeNull();
  });

  it("sends app paths back to the PostBus host", async () => {
    const response = await proxy(request("https://kala.postbus.in/dashboard/orders?x=1"));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://www.postbus.in/dashboard/orders?x=1");
  });

  it("cleans up /store/{slug} links on the merchant host and cannot reach another store", async () => {
    const own = await proxy(request("https://kala.postbus.in/store/kala/products/mug"));
    expect(own.status).toBe(308);
    expect(own.headers.get("location")).toBe("https://kala.postbus.in/products/mug");
    const other = await proxy(request("https://kala.postbus.in/store/priya"));
    expect(other.status).toBe(308);
    expect(other.headers.get("location")).toBe("https://priya.postbus.in/");
  });

  it("keeps tracking-only subdomains on the tracking page", async () => {
    const response = await proxy(request("https://shiprocket-fans.postbus.in/anything"));
    expect(rewriteOf(response)).toBe("https://shiprocket-fans.postbus.in/track");
    expect(forwarded(response, "x-tracking-subdomain")).toBe("shiprocket-fans");
  });
});

describe("legacy URL migration", () => {
  it("301s www.postbus.in/store/{slug}/… to the subdomain with the query", async () => {
    const response = await proxy(request("https://www.postbus.in/store/kala/products/mug?discount=SAVE10"));
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://kala.postbus.in/products/mug?discount=SAVE10");
    const apex = await proxy(request("https://postbus.in/store/kala"));
    expect(apex.status).toBe(301);
    expect(apex.headers.get("location")).toBe("https://kala.postbus.in/");
  });

  it("leaves unknown stores on the path (the page handles renamed slugs)", async () => {
    const response = await proxy(request("https://www.postbus.in/store/old-name"));
    expect(response.status).toBe(200);
  });

  it("changes nothing while the switch is off", async () => {
    vi.stubEnv("STOREFRONT_SUBDOMAINS_ENABLED", "false");
    const legacy = await proxy(request("https://www.postbus.in/store/kala"));
    expect(legacy.status).toBe(200);
    const host = await proxy(request("https://kala.postbus.in/"));
    expect(rewriteOf(host)).toBe("https://kala.postbus.in/track");
  });
});
