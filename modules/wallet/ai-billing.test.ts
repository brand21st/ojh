import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const admin = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  hasAdminClient: () => true,
  createAdminClient: () => admin,
}));

import { consumeAiCredit, getAiCreditsRemaining, reserveAiCredits, finalizeAiCreditReservation } from "@/modules/ai-credits/service";
import { featureForReason, openRouterUsage } from "@/modules/wallet/ai-billing";

const ORG = "30000000-0000-4000-8000-000000000001";

/** Wallet of Rs 1.00 available at the Rs 0.20 cutover rate: 5 credits' worth. */
function walletTables() {
  admin.from.mockImplementation((table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      insert: async () => ({ error: null }),
      maybeSingle: async () =>
        table === "wallets"
          ? { data: { status: "ACTIVE", balance_micros: "1100000", reserved_micros: "100000", credit_limit_micros: "0" }, error: null }
          : { data: { wallet_ai_credit_rate_micros: "200000" }, error: null },
    };
    return chain;
  });
}

function userClient() {
  return { rpc: vi.fn(async () => ({ data: { remaining: 7, consumed: true }, error: null })), from: vi.fn() };
}

beforeEach(() => {
  vi.stubEnv("WALLET_ENABLED", "true");
  walletTables();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("helpers", () => {
  it("maps legacy reasons to features unless the caller names one", () => {
    expect(featureForReason("AI_ADDRESS_EXTRACTION")).toBe("data_extraction");
    expect(featureForReason("AI_ADDRESS_EXTRACTION", "address_checker")).toBe("address_checker");
    expect(featureForReason("SOMETHING_NEW")).toBe("*");
  });

  it("reads OpenRouter token counts and ignores junk", () => {
    expect(openRouterUsage({ usage: { prompt_tokens: 812, completion_tokens: 95 } })).toEqual({ inputTokens: 812, outputTokens: 95 });
    expect(openRouterUsage({ usage: { prompt_tokens: -1, completion_tokens: "9" } })).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(openRouterUsage(null)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("AI credit functions for a wallet-billed organization", () => {
  beforeEach(() => {
    admin.rpc.mockImplementation(async (fn: string) => {
      if (fn === "wallet_ai_mode") return { data: "wallet", error: null };
      if (fn === "wallet_ai_charge") return { data: { status: "CHARGED", chargeMicros: "200000" }, error: null };
      if (fn === "wallet_ai_reserve") return { data: { status: "HELD" }, error: null };
      if (fn === "wallet_ai_settle") return { data: { status: "CHARGED" }, error: null };
      return { data: null, error: { code: "PGRST202", message: "unexpected" } };
    });
  });

  it("shows the balance in credit terms", async () => {
    const user = userClient();
    expect(await getAiCreditsRemaining(user as never, ORG)).toBe(5);
    expect(user.from).not.toHaveBeenCalled();
  });

  it("charges the wallet with the feature, model and tokens, not legacy credits", async () => {
    const user = userClient();
    const remaining = await consumeAiCredit(user as never, ORG, {
      reason: "AI_ADDRESS_EXTRACTION",
      idempotencyKey: "prebooking-address:1",
      feature: "address_validation",
      model: "openai/gpt-4o-mini",
      usage: { inputTokens: 700, outputTokens: 80 },
    });
    expect(remaining).toBe(5);
    expect(user.rpc).not.toHaveBeenCalled();
    expect(admin.rpc).toHaveBeenCalledWith("wallet_ai_charge", expect.objectContaining({
      p_org: ORG,
      p_feature: "address_validation",
      p_model: "openai/gpt-4o-mini",
      p_idempotency_key: "prebooking-address:1",
      p_input_tokens: 700,
      p_output_tokens: 80,
    }));
  });

  it("returns null when the wallet refuses, so callers drop the AI result", async () => {
    admin.rpc.mockImplementation(async (fn: string) =>
      fn === "wallet_ai_mode" ? { data: "wallet", error: null } : { data: { status: "INSUFFICIENT_BALANCE" }, error: null }
    );
    expect(await consumeAiCredit(userClient() as never, ORG, { reason: "AI_PRODUCT_COPY" })).toBeNull();
  });

  it("holds and settles image jobs on the wallet", async () => {
    const user = userClient();
    const held = await reserveAiCredits(user as never, ORG, {
      qty: 30,
      reason: "AI_IMAGE_STUDIO",
      idempotencyKey: "job-1",
      feature: "image_studio",
      model: "img",
      units: 3,
    });
    expect(held).toMatchObject({ reserved: true, status: "RESERVED" });
    expect(admin.rpc).toHaveBeenCalledWith("wallet_ai_reserve", expect.objectContaining({ p_units: 3, p_feature: "image_studio" }));
    expect(await finalizeAiCreditReservation(user as never, ORG, "job-1")).toEqual({ ok: true, status: "CHARGED" });
    expect(user.rpc).not.toHaveBeenCalled();
  });
});

describe("AI credit functions while the wallet is off", () => {
  it("never asks the wallet and spends legacy credits", async () => {
    vi.stubEnv("WALLET_ENABLED", "");
    const user = userClient();
    expect(await consumeAiCredit(user as never, ORG, { reason: "AI_PRODUCT_COPY" })).toBe(7);
    expect(user.rpc).toHaveBeenCalledWith("consume_ai_credit", expect.objectContaining({ p_org: ORG }));
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("stays on legacy credits for an organization not moved yet", async () => {
    admin.rpc.mockResolvedValue({ data: "credits", error: null });
    const user = userClient();
    expect(await consumeAiCredit(user as never, ORG, { reason: "AI_PRODUCT_COPY" })).toBe(7);
    expect(admin.rpc).toHaveBeenCalledTimes(1);
  });
});
