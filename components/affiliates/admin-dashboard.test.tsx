/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const partner = "20000000-0000-4000-8000-000000000001";
const responses: Record<string, unknown> = {
  overview: { partners: 3, active: 2, applications: 1, links: 4, signups: 9, paidMerchants: 5, earned: "150000", paid: "50000", liabilities: "100000", review: 2 },
  settings: [{ registration_open: true, attribution_days: 30, hold_days: 30, minimum_payout_paise: 100000 }],
  policies: [{ affiliate_id: null, link_id: null, basis_points: 2000 }],
  applications: [{ id: partner, status: "PENDING", created_at: "2026-11-18T10:00:00Z", application: { fullName: "Ravi Kumar", mobile: "+919847000000", channel: "YouTube", city: "Kochi", state: "Kerala", business: "Ravi Ships" } }],
  payouts: [{ id: "p1", affiliate_id: partner, partner_name: "Ravi Kumar", account_id: "a1", amount_paise: 250050, status: "REQUESTED", created_at: "2026-11-19T10:00:00Z" }],
};
vi.mock("@/lib/hooks/use-api", () => ({
  api: vi.fn(async (path: string) => {
    const section = path.replace("/api/admin/affiliates/", "").split(/[/?]/)[0];
    return responses[section] ?? [];
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

import { AffiliateAdminDashboard } from "./admin-dashboard";

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function render() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <AffiliateAdminDashboard payoutsEnabled={false} accrualEnabled />
      </QueryClientProvider>
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return container;
}

describe("affiliate admin dashboard", () => {
  it("shows formatted KPIs, program terms, the review alert and pending applications", async () => {
    const view = await render();
    const text = view.textContent ?? "";
    expect(text).toContain("Partner program");
    expect(text).toContain("₹1,000.00"); // liabilities 100000 paise
    expect(text).toContain("Default rate 20%");
    expect(text).toContain("Payouts off");
    expect(text).toContain("2 captured payment(s) need review");
    expect(text).toContain("Ravi Kumar");
    expect(text).toContain("YouTube");
    expect([...view.querySelectorAll("button")].some((b) => b.textContent?.includes("Approve"))).toBe(true);
    expect(text).not.toContain(partner);
  });
});
