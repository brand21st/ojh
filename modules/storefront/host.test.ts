import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAppOnlyPath,
  isReservedStoreSubdomain,
  legacyStoreRedirectTarget,
  parseLegacyStorePath,
  storeBasePath,
  storeHostInternalPath,
  storePublicUrl,
  storeSubdomainUrl,
} from "./host";
import { storeAddressSchema } from "./schema";
import { rebaseStoreHref } from "@/components/storefront/store-base";

afterEach(() => vi.unstubAllEnvs());

describe("store subdomain URLs", () => {
  it("builds https://{slug}.postbus.in in production and {slug}.localhost in dev", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.postbus.in");
    expect(storeSubdomainUrl("tekiom-ventures")).toBe("https://tekiom-ventures.postbus.in");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    expect(storeSubdomainUrl("tekiom-ventures")).toBe("http://tekiom-ventures.localhost:3000");
  });

  it("keeps the legacy path until the switch is on", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.postbus.in");
    vi.stubEnv("STOREFRONT_SUBDOMAINS_ENABLED", "");
    expect(storePublicUrl("kala", "/products/mug")).toBe("https://www.postbus.in/store/kala/products/mug");
    vi.stubEnv("STOREFRONT_SUBDOMAINS_ENABLED", "true");
    expect(storePublicUrl("kala", "/products/mug")).toBe("https://kala.postbus.in/products/mug");
    expect(storePublicUrl("kala")).toBe("https://kala.postbus.in");
  });
});

describe("legacy /store/{slug} paths", () => {
  it("parses slug and subpath", () => {
    expect(parseLegacyStorePath("/store/Kala")).toEqual({ workspace: "kala", rest: "" });
    expect(parseLegacyStorePath("/store/kala/")).toEqual({ workspace: "kala", rest: "" });
    expect(parseLegacyStorePath("/store/kala/products/mug")).toEqual({ workspace: "kala", rest: "/products/mug" });
    expect(parseLegacyStorePath("/store-preview")).toBeNull();
    expect(parseLegacyStorePath("/store/bad_slug")).toBeNull();
    expect(parseLegacyStorePath("/store/a--b")).toBeNull();
  });

  it("redirects to the subdomain keeping subpath and query", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.postbus.in");
    expect(legacyStoreRedirectTarget("/store/kala/category/mugs", "?discount=SAVE10&utm_source=ig")).toBe(
      "https://kala.postbus.in/category/mugs?discount=SAVE10&utm_source=ig"
    );
    expect(legacyStoreRedirectTarget("/store/kala", "")).toBe("https://kala.postbus.in/");
    // Infra hosts are never a store.
    expect(legacyStoreRedirectTarget("/store/www", "")).toBeNull();
    expect(legacyStoreRedirectTarget("/store/api/x", "")).toBeNull();
  });
});

describe("host path mapping", () => {
  it("maps host paths onto the store route", () => {
    expect(storeHostInternalPath("/", "kala")).toBe("/store/kala");
    expect(storeHostInternalPath("/products/mug", "kala")).toBe("/store/kala/products/mug");
    expect(storeHostInternalPath("/privacy-policy/", "kala")).toBe("/store/kala/privacy-policy");
  });

  it("keeps the dashboard and auth on the PostBus host", () => {
    for (const path of ["/dashboard", "/dashboard/inventory", "/login", "/admin/x", "/auth/callback", "/store-preview"]) {
      expect(isAppOnlyPath(path)).toBe(true);
    }
    for (const path of ["/", "/products/mug", "/category/x", "/track", "/dashboards"]) {
      expect(isAppOnlyPath(path)).toBe(false);
    }
  });

  it("rebases store links for the merchant host", () => {
    expect(storeBasePath("kala", true)).toBe("");
    expect(storeBasePath("kala", false)).toBe("/store/kala");
    expect(rebaseStoreHref("/store/kala", "kala", "")).toBe("/");
    expect(rebaseStoreHref("/store/kala/products/mug", "kala", "")).toBe("/products/mug");
    expect(rebaseStoreHref("/store/kala?discount=X", "kala", "")).toBe("/?discount=X");
    expect(rebaseStoreHref("/store/kala/products/mug", "kala", "/store/kala")).toBe("/store/kala/products/mug");
    // Never rewrites another store's links or similar prefixes.
    expect(rebaseStoreHref("/store/kalaghar", "kala", "")).toBe("/store/kalaghar");
    expect(rebaseStoreHref("https://example.com/store/kala", "kala", "")).toBe("https://example.com/store/kala");
  });
});

describe("reserved subdomains", () => {
  it("refuses system names for new store addresses", () => {
    for (const slug of ["www", "api", "admin", "dashboard", "app", "mail", "support", "track", "status", "cdn", "billing", "checkout"]) {
      expect(isReservedStoreSubdomain(slug)).toBe(true);
      expect(storeAddressSchema.safeParse({ slug }).success).toBe(false);
    }
    expect(storeAddressSchema.safeParse({ slug: "tekiom-ventures" }).success).toBe(true);
    expect(storeAddressSchema.safeParse({ slug: "-x-" }).success).toBe(false);
    expect(storeAddressSchema.safeParse({ slug: "x".repeat(49) }).success).toBe(false);
  });
});
