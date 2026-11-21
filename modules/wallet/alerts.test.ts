import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverWalletAlerts, renderLowBalanceAlert, walletAlertRecipients, type ClaimedAlert } from "@/modules/wallet/alerts";

const alert: ClaimedAlert = {
  organizationId: "30000000-0000-4000-8000-000000000001",
  organizationName: "Kerala <Spice> Co",
  thresholdMicros: "50000000",
  balanceMicros: "42500000",
  availableMicros: "42500000",
  walletStatus: "ACTIVE",
  ownerEmails: ["owner@kerala.test", "not-an-email"],
};

afterEach(() => vi.unstubAllEnvs());

describe("walletAlertRecipients", () => {
  it("sends nothing unless wallet email is turned on", () => {
    vi.stubEnv("WALLET_EMAIL_ENABLED", "");
    expect(walletAlertRecipients(["owner@kerala.test"])).toEqual([]);
  });

  it("only mails the test inbox outside production", () => {
    vi.stubEnv("WALLET_EMAIL_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "development");
    expect(walletAlertRecipients(["owner@kerala.test"])).toEqual([]);
    vi.stubEnv("WALLET_EMAIL_TEST_RECIPIENT", "qa@postbus.test");
    expect(walletAlertRecipients(["owner@kerala.test"])).toEqual(["qa@postbus.test"]);
  });

  it("mails valid owner addresses in production", () => {
    vi.stubEnv("WALLET_EMAIL_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTBUS_ENV", "production");
    expect(walletAlertRecipients(alert.ownerEmails)).toEqual(["owner@kerala.test"]);
  });
});

describe("renderLowBalanceAlert", () => {
  it("names the level and balance and escapes the workspace name", () => {
    const message = renderLowBalanceAlert(alert, "https://app.postbus.in/");
    expect(message.title).toBe("PostBus wallet below Rs 50.00");
    expect(message.body).toContain("Rs 42.50");
    expect(message.html).toContain("Kerala &lt;Spice&gt; Co");
    expect(message.html).toContain("https://app.postbus.in/dashboard/wallet");
  });

  it("says when the wallet is empty or on hold", () => {
    expect(renderLowBalanceAlert({ ...alert, availableMicros: "0" }, "x").title).toBe("Your PostBus wallet is empty");
    expect(renderLowBalanceAlert({ ...alert, walletStatus: "FROZEN" }, "x").title).toBe("Your PostBus wallet is on hold");
  });
});

describe("deliverWalletAlerts", () => {
  it("posts an in-app notice for each alert and emails owners when allowed", async () => {
    vi.stubEnv("WALLET_EMAIL_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTBUS_ENV", "production");
    vi.stubEnv("WALLET_SMTP_FROM_EMAIL", "alerts@postbus.in");
    const insert = vi.fn(async () => ({ error: null }));
    const db = {
      rpc: vi.fn(async () => ({ data: [alert], error: null })),
      from: vi.fn(() => ({ insert })),
    } as unknown as SupabaseClient;
    const sendMail = vi.fn(async () => ({}));
    const result = await deliverWalletAlerts(db, { sendMail });
    expect(result).toEqual({ alerts: 1, notified: 1, emailed: 1, emailFailed: 0 });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ organization_id: alert.organizationId, type: "wallet.low_balance" }));
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: ["owner@kerala.test"], from: "PostBus <alerts@postbus.in>" }));
  });

  it("does not retry a failed email, so nobody gets duplicates", async () => {
    vi.stubEnv("WALLET_EMAIL_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTBUS_ENV", "production");
    const db = {
      rpc: vi.fn(async () => ({ data: [alert], error: null })),
      from: vi.fn(() => ({ insert: async () => ({ error: null }) })),
    } as unknown as SupabaseClient;
    const result = await deliverWalletAlerts(db, { sendMail: async () => Promise.reject(new Error("smtp down")) });
    expect(result).toMatchObject({ notified: 1, emailed: 0, emailFailed: 1 });
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });
});
