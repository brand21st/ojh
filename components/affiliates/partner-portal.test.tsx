/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/partner/dashboard" }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signOut: async () => undefined } }) }));
vi.mock("@/lib/analytics/posthog", () => ({ resetAnalyticsUser: vi.fn() }));
vi.mock("recharts", () => {
  const Box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { ResponsiveContainer: Box, AreaChart: Box, Area: () => null, CartesianGrid: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null };
});

const me = {
  email: "ravi@example.in",
  payoutsEnabled: true,
  profile: { id: "p1", status: "APPROVED", created_at: "2026-10-01T00:00:00Z", application: { fullName: "Ravi Kumar" } },
  settings: { minimum_payout_paise: 100000, hold_days: 30, attribution_days: 30, registration_open: true, default_basis_points: 2000 },
};
const overview = {
  automatic: true,
  balance: { available: "425050", recoverable: "0", paid: "1000000" },
  minimumPaise: "100000",
  nextPayoutDate: "2026-12-05",
  payoutDay: 5,
  account: { masked: "UPI •••3210", addedAt: "2026-10-02T00:00:00Z", heldUntil: "2026-10-05T00:00:00Z" },
  openPayout: null,
  rules: { maxPaise: "1000000", holdHours: 72 },
};
const responses: Record<string, unknown> = {
  me,
  "payouts/overview": overview,
  summary: { balance: overview.balance, clicks: 120, visitors: 90, signups: 6, conversions: 3, earned: "300000", pending: "50000", reserved: "0", daily: [], activity: [] },
  links: { rows: [] },
  accounts: [{ id: "acct-1", masked_details: "UPI •••3210" }],
  payouts: [
    { id: "po1", amount_paise: 1000000, status: "PAID", utr: "UTR998877", created_at: "2026-11-05T05:00:00Z", settled_at: "2026-11-05T05:10:00Z", origin: "AUTO" },
    { id: "po2", amount_paise: 250000, status: "REVIEW", hold_reason: "NEW_ACCOUNT", created_at: "2026-11-20T05:00:00Z" },
  ],
};
vi.mock("@/lib/hooks/use-api", () => ({
  api: vi.fn(async (path: string) => {
    const key = path.replace("/api/partner/", "").split("?")[0];
    return responses[key] ?? [];
  }),
}));

import { PartnerOverview, PartnerPayouts } from "./partner-portal";

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function render(node: React.ReactNode) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return container;
}

describe("partner portal", () => {
  it("overview shows the available balance, next automatic payout and UPI", async () => {
    const text = (await render(<PartnerOverview />)).textContent ?? "";
    expect(text).toContain("Hi Ravi");
    expect(text).toContain("₹4,250.50");
    expect(text).toContain("Next automatic payout");
    expect(text).toContain("5 Dec 2026");
    expect(text).toContain("•••3210");
    expect(text).toContain("Active partner");
    expect(text).toContain("20% recurring commission");
  });

  it("payouts lists paid UTRs and explains held payouts", async () => {
    const view = await render(<PartnerPayouts />);
    const text = view.textContent ?? "";
    expect(text).toContain("5th of every month");
    expect(text).toContain("UTR998877");
    expect(text).toContain("Being reviewed");
    expect(text).toContain("UPI ID was added recently");
    expect(text).toContain("Request ₹4,250.50");
  });
});
