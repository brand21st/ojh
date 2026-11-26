import { describe, expect, it } from "vitest";
import { buildPerformance, istDay, istDayStart, resolveRange } from "@/modules/team/performance";

describe("team performance", () => {
  it("uses India days", () => {
    expect(istDay(new Date("2026-11-26T19:00:00Z"))).toBe("2026-11-27");
    expect(istDay(new Date("2026-11-26T18:00:00Z"))).toBe("2026-11-26");
    expect(istDayStart("2026-11-27").toISOString()).toBe("2026-11-26T18:30:00.000Z");
  });

  it("defaults to the last 7 days and clamps bad input", () => {
    const now = new Date("2026-11-27T06:00:00Z");
    expect(resolveRange({}, now)).toMatchObject({ from: "2026-11-21", to: "2026-11-27" });
    expect(resolveRange({ from: "2026-12-01", to: "2026-12-05" }, now)).toMatchObject({ from: "2026-11-27", to: "2026-11-27" });
    expect(resolveRange({ from: "2020-01-01", to: "2026-11-27" }, now).from).toBe("2026-08-27");
  });

  it("totals per member, keeps idle members, and ranks by work", () => {
    const people = new Map([
      ["a", { name: "Asha", email: "a@x.in", role: "OPERATOR" as const, team: "FULFILLMENT" }],
      ["b", { name: "Ravi", email: "b@x.in", role: "PACKER" as const, team: "PACKING" }],
      ["c", { name: "Idle", email: "c@x.in", role: "VIEWER" as const, team: null }],
    ]);
    const result = buildPerformance(
      [
        { actor_id: "a", day: "2026-11-26", action: "order.booked", events: 30, quantity: 30 },
        { actor_id: "a", day: "2026-11-27", action: "order.booked", events: "12", quantity: "12" },
        { actor_id: "b", day: "2026-11-27", action: "order.packed", events: 50, quantity: 50 },
        { actor_id: "a", day: "2026-11-27", action: "manifest.created", events: 2, quantity: 40 },
        { actor_id: null, day: "2026-11-27", action: "order.booked", events: 5, quantity: 5 },
        { actor_id: "a", day: "2026-11-27", action: "unknown", events: 9, quantity: 9 },
      ],
      people,
      { from: "2026-11-26", to: "2026-11-27" }
    );
    expect(result.days).toEqual(["2026-11-26", "2026-11-27"]);
    expect(result.totals).toEqual({ "order.booked": 47, "order.packed": 50, "label.printed": 0, "manifest.created": 40 });
    expect(result.members.map((member) => member.name)).toEqual(["Ravi", "Asha", "Automation", "Idle"]);
    const asha = result.members.find((member) => member.actorId === "a")!;
    expect(asha.bestDay).toEqual({ day: "2026-11-26", count: 30 });
    expect(asha.activeDays).toBe(2);
    expect(result.daily.filter((row) => row.actorId === "a")).toHaveLength(2);
  });
});
