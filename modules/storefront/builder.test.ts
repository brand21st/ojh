import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TenantContext } from "@/lib/api/context";
import { DEFAULT_FOOTER_CONFIG } from "./footer";
import { defaultSections, storeLayoutSchema } from "./layout/schema";
import { buildStorefrontPreview, type StorefrontPreviewSettings } from "./preview";
import { getStoreBuilderState, layoutFromLegacy, legacyColumnsFromDraft, parseDraft, publishStoreDraft, saveStoreDraft } from "./builder";
import { storeBuilderLegacyRedirects } from "@/lib/dashboard/legacy-redirects";

const org = "10000000-0000-4000-8000-000000000001";
const ctx: TenantContext = { userId: "u1", email: null, fullName: null, organizationId: org, organizationName: "Org", role: "MANAGER", permissions: [] };

/** Minimal chainable Supabase stub: every query resolves to the queued result for its table. */
function fakeSupabase(rows: Record<string, unknown>, opts: { count?: number } = {}) {
  const calls: Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> }> = [];
  const rpc = vi.fn().mockResolvedValue({ data: new Date().toISOString(), error: null });
  const from = (table: string) => {
    const call = { table, op: "select", payload: undefined as unknown, filters: [] as Array<[string, unknown]> };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    Object.assign(builder, {
      select: chain,
      eq: (column: string, value: unknown) => { call.filters.push([column, value]); return builder; },
      in: chain,
      order: chain,
      limit: chain,
      gte: chain,
      upsert: (payload: unknown) => { call.op = "upsert"; call.payload = payload; return builder; },
      update: (payload: unknown) => { call.op = "update"; call.payload = payload; return builder; },
      insert: (payload: unknown) => { call.op = "insert"; call.payload = payload; return Promise.resolve({ error: null }); },
      maybeSingle: () => Promise.resolve({ data: table === "storefront_settings" ? rows : null, error: null }),
      then: (resolve: (value: unknown) => void) => resolve({ data: [], error: null, count: opts.count ?? 0 }),
    });
    return builder;
  };
  return { client: { from, rpc } as unknown as SupabaseClient, calls, rpc };
}

describe("store builder draft helpers", () => {
  it("derives a classic-equivalent layout from legacy columns", () => {
    const layout = layoutFromLegacy({ accent_color: "#059669", theme: { secondaryColor: "#111111", font: "manrope" } });
    expect(layout.themeId).toBe("classic");
    expect(layout.tokens).toMatchObject({ accent: "#059669", secondary: "#111111", font: "manrope" });
    expect(layout.sections.map((s) => s.type)).toEqual(defaultSections().map((s) => s.type));
  });

  it("maps a draft back to valid legacy columns (fonts the classic store lacks fall back to geist)", () => {
    const draft = parseDraft({
      layout: { tokens: { accent: "#abcdef", secondary: "#123123", font: "poppins" }, sections: [] },
      footer: DEFAULT_FOOTER_CONFIG,
      featuredProductIds: [org, org],
    });
    const legacy = legacyColumnsFromDraft(draft);
    expect(legacy.accentColor).toBe("#ABCDEF");
    expect(legacy.theme).toEqual({ version: 1, secondaryColor: "#123123", font: "geist" });
    expect(legacy.featuredProductIds).toEqual([org]);
  });

  it("starts the editor from the live store when there is no draft", async () => {
    const { client } = fakeSupabase({ accent_color: "#2563EB", theme: {}, footer: {}, featured_product_ids: [org], draft_layout: null, published_layout: null });
    const state = await getStoreBuilderState(client, ctx);
    expect(state.draft.layout.tokens.accent).toBe("#2563EB");
    expect(state.draft.featuredProductIds).toEqual([org]);
    expect(state.hasUnpublishedChanges).toBe(false);
    expect(state.publishedLayout).toBeNull();
  });

  it("saving a draft writes only draft columns, never the live ones", async () => {
    const { client, calls } = fakeSupabase({ draft_layout: null, draft_updated_at: null }, { count: 0 });
    await saveStoreDraft(client, ctx, { layout: storeLayoutSchema.parse({ sections: [] }), footer: DEFAULT_FOOTER_CONFIG, featuredProductIds: [] });
    const write = calls.find((call) => call.table === "storefront_settings" && call.op === "upsert");
    expect(Object.keys(write?.payload as object).sort()).toEqual(["draft_layout", "draft_updated_at", "organization_id"]);
    expect((write?.payload as { organization_id: string }).organization_id).toBe(org);
  });

  it("rejects a stale draft save", async () => {
    const { client } = fakeSupabase({ draft_layout: {}, draft_updated_at: "2026-11-20T10:00:00.000Z" });
    await expect(
      saveStoreDraft(client, ctx, { layout: { sections: [] }, footer: DEFAULT_FOOTER_CONFIG, featuredProductIds: [], expectedDraftUpdatedAt: "2026-11-20T09:00:00.000Z" })
    ).rejects.toThrow(/changed this draft/);
  });

  it("refuses featured products from another merchant", async () => {
    const { client } = fakeSupabase({}, { count: 0 });
    await expect(saveStoreDraft(client, ctx, { layout: { sections: [] }, footer: DEFAULT_FOOTER_CONFIG, featuredProductIds: ["20000000-0000-4000-8000-000000000002"] })).rejects.toThrow(/not found/);
  });

  it("publishes through the RPC with tenant-scoped arguments", async () => {
    const stored = { layout: storeLayoutSchema.parse({ sections: [] }), footer: DEFAULT_FOOTER_CONFIG, featuredProductIds: [] };
    const { client, rpc } = fakeSupabase({ draft_layout: stored, draft_updated_at: "2026-11-20T10:00:00.000Z" });
    await publishStoreDraft(client, ctx, { expectedDraftUpdatedAt: "2026-11-20T10:00:00.000Z" });
    expect(rpc).toHaveBeenCalledWith("publish_storefront_layout", expect.objectContaining({ p_organization_id: org, p_expected_draft_updated_at: "2026-11-20T10:00:00.000Z" }));
  });

  it("will not publish when there is no draft", async () => {
    const { client } = fakeSupabase({ draft_layout: null });
    await expect(publishStoreDraft(client, ctx, {})).rejects.toThrow(/no changes/);
  });
});

describe("draft preview", () => {
  const settings: StorefrontPreviewSettings = {
    storeName: "Kala", logoUrl: null, accentColor: "#E11D48", seoTitle: null, seoDescription: null,
    featuredProductIds: [], slides: [], workspace: "kala", footer: DEFAULT_FOOTER_CONFIG, marketplace: false, whatsappPhone: "9876543210",
  };

  it("renders the marketplace layout with draft tokens even when the env flag is off", () => {
    const layout = storeLayoutSchema.parse({ tokens: { accent: "#16a34a" }, sections: [], whatsappButton: { enabled: true } });
    const store = buildStorefrontPreview({ settings, products: [], categories: [], bundles: [], drafts: { layout } });
    expect(store.marketplace).toBe(true);
    expect(store.layout?.tokens.accent).toBe("#16a34a");
    expect(store.accentColor).toBe("#16a34a");
    expect(store.whatsappPhone).toBe("9876543210");
  });

  it("keeps the classic payload when there is no draft layout", () => {
    const store = buildStorefrontPreview({ settings, products: [], categories: [], bundles: [] });
    expect(store.marketplace).toBe(false);
    expect(store.layout).toBeNull();
    expect(store.whatsappPhone).toBeNull();
  });
});

describe("legacy inventory tab redirects", () => {
  it("sends the moved tabs to the Store Builder", () => {
    const redirects = storeBuilderLegacyRedirects();
    expect(redirects.map((r) => [r.has[0].value, r.destination])).toEqual([
      ["storefront", "/dashboard/store-builder/customize"],
      ["covers", "/dashboard/store-builder/marketing"],
      ["coupons", "/dashboard/store-builder/marketing"],
    ]);
    expect(redirects.every((r) => r.source === "/dashboard/inventory" && r.permanent === false)).toBe(true);
  });
});
