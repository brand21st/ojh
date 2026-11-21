import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const h = vi.hoisted(() => ({
  creds: vi.fn(),
  hold: vi.fn(),
  settle: vi.fn(),
  upsertLog: vi.fn(async () => null),
}));

vi.mock("@/modules/whatsapp/channel", () => ({ isOrgWatiConnected: async () => false }));
vi.mock("@/modules/automation/service", () => ({ isAutoWatiEventEnabled: async () => true }));
vi.mock("@/modules/wati/send", () => ({
  loadNoticeContext: async () => ({
    phone: "+919876543210",
    customerName: "Priya",
    orderNumber: "PB-1001",
    amount: 49900,
    deliveryAddress: "Bengaluru",
    trackingNumber: "EK123456789IN",
    barcode: null,
  }),
}));
vi.mock("@/modules/vachat/platform-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/vachat/platform-config")>();
  return {
    ...actual,
    resolveVachatSendCredentials: (...a: unknown[]) => h.creds(...a),
    getPlatformVachatConfig: async () => ({ ...actual.defaultVachatEventSettings, eventSettings: { booked: true } }),
    isPlatformVachatActive: () => true,
    merchantVachatRowReady: () => false,
  };
});
vi.mock("@/modules/vachat/logs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/vachat/logs")>();
  return { ...actual, upsertVachatNotificationLog: (...a: unknown[]) => h.upsertLog(...a) };
});
vi.mock("@/modules/wallet/whatsapp-billing", () => ({
  HELD_FOR_BALANCE_STATUS: "held_balance",
  holdWhatsappNotice: (...a: unknown[]) => h.hold(...a),
  settleWhatsappNotice: (...a: unknown[]) => h.settle(...a),
}));

import { sendVachatNotice } from "@/modules/vachat/send";

const ORG = "30000000-0000-4000-8000-000000000001";
const ids = { shipmentId: "40000000-0000-4000-8000-000000000001", orderId: "50000000-0000-4000-8000-000000000001" };

function supabase() {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { name: "Shop" } }) };
  return { from: () => chain } as unknown as SupabaseClient;
}

const platformCreds = { source: "platform", apiKey: "k", apiBaseUrl: "https://vachat.example" };

beforeEach(() => {
  h.creds.mockResolvedValue(platformCreds);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: { message_id: "m1", whatsapp_message_id: "w1" } }), { status: 200 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("sendVachatNotice wallet billing", () => {
  it("holds the price, sends, and records the provider ids against the hold", async () => {
    h.hold.mockResolvedValue({ proceed: true, billed: true, status: "HELD" });
    const result = await sendVachatNotice(supabase(), ORG, "booked", ids);
    expect(result).toMatchObject({ sent: true, messageId: "m1" });
    expect(h.hold).toHaveBeenCalledWith(ORG, expect.objectContaining({ event: "booked", phone: "+919876543210" }));
    expect(h.settle).toHaveBeenCalledWith(ORG, expect.objectContaining({ outcome: "sent", providerMessageId: "m1", whatsappMessageId: "w1" }));
  });

  it("does not send and parks the notice when the wallet cannot pay", async () => {
    h.hold.mockResolvedValue({ proceed: false, billed: false, status: "INSUFFICIENT_BALANCE" });
    const result = await sendVachatNotice(supabase(), ORG, "booked", ids);
    expect(result).toEqual({ skipped: true, reason: "wallet_balance_low" });
    expect(fetch).not.toHaveBeenCalled();
    expect(h.upsertLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "held_balance",
      error: "wallet_balance_low",
      walletHoldPayload: expect.objectContaining({ event: "booked", shipmentId: ids.shipmentId, orderId: ids.orderId }),
    }));
  });

  it("releases the hold when VaChat errors, and still lets the job retry", async () => {
    h.hold.mockResolvedValue({ proceed: true, billed: true, status: "HELD" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 })));
    await expect(sendVachatNotice(supabase(), ORG, "booked", ids)).rejects.toThrow(/busy/);
    expect(h.settle).toHaveBeenCalledWith(ORG, expect.objectContaining({ outcome: "send_error" }));
  });

  it("never bills a merchant's own VaChat account", async () => {
    h.creds.mockResolvedValue({ source: "organization", apiKey: "k", apiBaseUrl: "https://vachat.example" });
    await sendVachatNotice(supabase(), ORG, "booked", ids);
    expect(h.hold).not.toHaveBeenCalled();
    expect(h.settle).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
