import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleBillingRoutes } from "@/lib/api/v1/billing";

const ctx = {
  userId: "u1",
  email: null,
  fullName: null,
  organizationId: "30000000-0000-4000-8000-000000000001",
  organizationName: "Merchant",
  role: "OWNER",
  permissions: [],
} as never;

function db() {
  const not = vi.fn();
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    eq: () => chain,
    not: (...args: unknown[]) => {
      not(...args);
      return chain;
    },
    order: () => chain,
    limit: async () => ({ data: [{ id: "p1" }] }),
  });
  return { client: { from: () => chain } as unknown as SupabaseClient, not };
}

afterEach(() => vi.unstubAllEnvs());

describe("GET billing/payments", () => {
  const request = new NextRequest("http://localhost/api/v1/billing/payments");

  it("never lists wallet recharges, and keeps AI credit packs while the wallet is off", async () => {
    vi.stubEnv("WALLET_ENABLED", "");
    const { client, not } = db();
    expect(await handleBillingRoutes(request, client, ctx, "GET billing/payments")).toEqual({ payments: [{ id: "p1" }] });
    expect(not).toHaveBeenCalledWith("payment_purpose", "in", "(wallet_recharge)");
  });

  it("shows only SaaS payments once AI credits live on the Wallet page", async () => {
    vi.stubEnv("WALLET_ENABLED", "true");
    const { client, not } = db();
    await handleBillingRoutes(request, client, ctx, "GET billing/payments");
    expect(not).toHaveBeenCalledWith("payment_purpose", "in", "(wallet_recharge,ai_credits)");
  });
});
