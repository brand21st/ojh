import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  admin: { rpc: vi.fn(), from: vi.fn() },
  createBackgroundJob: vi.fn(),
  hold: vi.fn(),
  settle: vi.fn(),
  upsertLog: vi.fn(),
  creds: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ hasAdminClient: () => true, createAdminClient: () => h.admin }));
vi.mock("@/modules/jobs/service", () => ({ createBackgroundJob: (...a: unknown[]) => h.createBackgroundJob(...a) }));

import {
  holdWhatsappNotice,
  resumeHeldWhatsappNotices,
  whatsappOutcomeFromWebhook,
} from "@/modules/wallet/whatsapp-billing";

const ORG = "30000000-0000-4000-8000-000000000001";
const POOR = "30000000-0000-4000-8000-000000000002";

beforeEach(() => vi.stubEnv("WALLET_ENABLED", "true"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("whatsappOutcomeFromWebhook", () => {
  it("maps provider statuses and Meta's billable flag", () => {
    expect(whatsappOutcomeFromWebhook("delivered")).toEqual({ outcome: "delivered", category: null });
    expect(whatsappOutcomeFromWebhook("READ", { billable: true, category: "utility" })).toEqual({ outcome: "read", category: "UTILITY" });
    expect(whatsappOutcomeFromWebhook("delivered", { billable: false, category: "service" })).toEqual({
      outcome: "not_billable",
      category: "SERVICE",
    });
    expect(whatsappOutcomeFromWebhook("failed").outcome).toBe("failed");
    expect(whatsappOutcomeFromWebhook("queued").outcome).toBeNull();
  });
});

describe("holdWhatsappNotice", () => {
  it("prices Indian numbers as IN and blocks only when the wallet cannot pay", async () => {
    h.admin.rpc.mockResolvedValueOnce({ data: { status: "HELD" }, error: null });
    expect(await holdWhatsappNotice(ORG, { externalRef: "r1", event: "booked", phone: "+919876543210" })).toEqual({
      proceed: true,
      billed: true,
      status: "HELD",
    });
    expect(h.admin.rpc).toHaveBeenCalledWith("wallet_whatsapp_reserve", expect.objectContaining({ p_country_code: "IN", p_category: "UTILITY" }));

    h.admin.rpc.mockResolvedValueOnce({ data: { status: "INSUFFICIENT_BALANCE" }, error: null });
    expect((await holdWhatsappNotice(ORG, { externalRef: "r2", event: "booked" })).proceed).toBe(false);
    h.admin.rpc.mockResolvedValueOnce({ data: { status: "WALLET_FROZEN" }, error: null });
    expect((await holdWhatsappNotice(ORG, { externalRef: "r3", event: "booked" })).proceed).toBe(false);
  });

  it("lets the notice go out when billing is off, unpriced or broken", async () => {
    for (const status of ["BILLING_OFF", "UNPRICED", "FREE"]) {
      h.admin.rpc.mockResolvedValueOnce({ data: { status }, error: null });
      expect(await holdWhatsappNotice(ORG, { externalRef: "r", event: "booked" })).toMatchObject({ proceed: true, billed: false });
    }
    h.admin.rpc.mockResolvedValueOnce({ data: null, error: { code: "57014", message: "timeout" } });
    expect(await holdWhatsappNotice(ORG, { externalRef: "r", event: "booked" })).toMatchObject({ proceed: true, billed: false });
  });

  it("never touches the wallet while WALLET_ENABLED is off", async () => {
    vi.stubEnv("WALLET_ENABLED", "");
    expect(await holdWhatsappNotice(ORG, { externalRef: "r", event: "booked" })).toEqual({ proceed: true, billed: false, status: "WALLET_OFF" });
    expect(h.admin.rpc).not.toHaveBeenCalled();
  });
});

describe("resumeHeldWhatsappNotices", () => {
  it("re-queues held notices only for wallets that can pay now", async () => {
    const updates: Array<Record<string, unknown>> = [];
    h.admin.from.mockImplementation((table: string) => {
      const filters: Record<string, string> = {};
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: (column: string, value: string) => {
          filters[column] = value;
          return chain;
        },
        gte: () => chain,
        order: () => chain,
        limit: async () => ({
          data: [
            { id: "log1", organization_id: ORG, wallet_hold_payload: { event: "booked", shipmentId: "s1", orderId: "o1", eventCode: null, occurredAt: null } },
            { id: "log2", organization_id: POOR, wallet_hold_payload: { event: "delivered", shipmentId: "s2", orderId: null, eventCode: null, occurredAt: null } },
          ],
          error: null,
        }),
        maybeSingle: async () => {
          if (table === "platform_settings") return { data: { wallet_whatsapp_resume_hours: 24 } };
          const rich = filters.organization_id === ORG;
          return {
            data: { status: "ACTIVE", balance_micros: rich ? "5000000" : "0", reserved_micros: "0", credit_limit_micros: "0" },
          };
        },
        update: (values: Record<string, unknown>) => {
          updates.push(values);
          return { eq: () => ({ eq: async () => ({ error: null }) }) };
        },
      });
      return chain;
    });

    expect(await resumeHeldWhatsappNotices()).toEqual({ resumed: 1 });
    expect(h.createBackgroundJob).toHaveBeenCalledTimes(1);
    expect(h.createBackgroundJob).toHaveBeenCalledWith(h.admin, expect.objectContaining({
      organizationId: ORG,
      jobType: "vachat-notify",
      entityType: "shipment",
      entityId: "s1",
      progress: expect.objectContaining({ event: "booked", resumedFromWalletHold: true }),
    }));
    expect(updates).toEqual([{ status: "queued", error: null, wallet_hold_payload: null }]);
  });
});
