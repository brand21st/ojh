import { describe, expect, it } from "vitest";
import {
  aggregateAnalytics,
  analyticsFetchSince,
  asAmount,
  emptyPeriod,
  inclusiveCalendarDays,
  isActiveOrder,
  isCodOrder,
  isIndiaPostBooked,
  isCodShipment,
  istDayStartIso,
  istParts,
  parseAnalyticsFocus,
  shipmentOrderAmount,
  startOfIstYearIso,
  type AnalyticsOrderRow,
  type AnalyticsShipmentRow,
} from "@/modules/dashboard/analytics";

const NOW = new Date("2026-09-20T12:00:00+05:30");

function order(
  createdAt: string,
  overrides: Partial<AnalyticsOrderRow> = {}
): AnalyticsOrderRow {
  return {
    created_at: createdAt,
    total_amount: 1000,
    source: "SHOPIFY",
    payment_status: "PAID",
    status: "READY",
    ...overrides,
  };
}

function shipment(
  createdAt: string,
  overrides: Partial<AnalyticsShipmentRow> = {}
): AnalyticsShipmentRow {
  return {
    created_at: createdAt,
    booked_at: null,
    payment_mode: "PREPAID",
    cod_amount: 0,
    status: "BOOKED",
    provider: "INDIA_POST",
    orders: { total_amount: 0 },
    ...overrides,
  };
}

describe("analytics helpers", () => {
  it("parses numeric amounts and skips cancelled or non-COD rows", () => {
    expect(asAmount("1499.50")).toBe(1499.5);
    expect(asAmount(null)).toBe(0);
    expect(isActiveOrder({ status: "CANCELLED" })).toBe(false);
    expect(isActiveOrder({ status: "READY" })).toBe(true);
    expect(isCodOrder({ payment_status: "COD" })).toBe(true);
    expect(isCodOrder({ payment_status: "PAID" })).toBe(false);
    expect(isCodShipment({ payment_mode: "COD" })).toBe(true);
    expect(isIndiaPostBooked({ provider: "INDIA_POST", booked_at: "2026-09-20T02:00:00+05:30", status: "BOOKED" })).toBe(
      true
    );
    expect(isIndiaPostBooked({ provider: "INDIA_POST", booked_at: null, status: "BOOKED" })).toBe(false);
    expect(isIndiaPostBooked({ provider: "INDIA_POST", booked_at: "2026-09-20T02:00:00+05:30", status: "CANCELLED" })).toBe(
      false
    );
    expect(shipmentOrderAmount({ orders: { total_amount: "450.25" } })).toBe(450.25);
    expect(shipmentOrderAmount({ orders: [{ total_amount: 1200 }] })).toBe(1200);
  });

  it("reads calendar parts in Asia/Kolkata", () => {
    const lateUtc = istParts("2026-09-19T19:30:00.000Z");
    expect(lateUtc.dateKey).toBe("2026-09-20");
    expect(lateUtc.hour).toBe(1);
    expect(startOfIstYearIso(NOW)).toBe("2025-12-31T18:30:00.000Z");
  });
});

describe("aggregateAnalytics", () => {
  it("returns zeroed buckets when there is no activity", () => {
    const result = aggregateAnalytics([], [], NOW);
    expect(result.today).toEqual(emptyPeriod());
    expect(result.series.today).toHaveLength(24);
    expect(result.series.month).toHaveLength(20);
    expect(result.series.year).toHaveLength(9);
    expect(result.topSource).toBeNull();
  });

  it("rolls orders and shipments into today, month, and year", () => {
    const result = aggregateAnalytics(
      [
        order("2026-09-20T01:15:00+05:30", { total_amount: 500, source: "SHOPIFY" }),
        order("2026-09-05T10:00:00+05:30", { total_amount: 200, source: "MANUAL" }),
        order("2026-01-02T09:00:00+05:30", { total_amount: 100, source: "API" }),
        order("2025-12-31T23:00:00+05:30", { total_amount: 999, source: "SHOPIFY" }),
        order("2026-09-20T08:00:00+05:30", { status: "CANCELLED", total_amount: 50 }),
      ],
      [
        shipment("2026-09-20T02:00:00+05:30"),
        shipment("2026-09-08T11:00:00+05:30"),
        shipment("2026-09-20T03:00:00+05:30", { status: "CANCELLED" }),
      ],
      NOW
    );

    expect(result.today.orders).toBe(1);
    expect(result.today.revenue).toBe(500);
    expect(result.today.shipments).toBe(1);
    expect(result.month.orders).toBe(2);
    expect(result.month.revenue).toBe(700);
    expect(result.month.shipments).toBe(2);
    expect(result.year.orders).toBe(3);
    expect(result.year.revenue).toBe(800);
    expect(result.year.prepaidOrders).toBe(3);
    expect(result.year.prepaidAmount).toBe(800);
    expect(result.year.shipments).toBe(2);
    expect(result.today.indiaPostBooked).toBe(0);
    expect(result.series.today[1]?.orders).toBe(1);
    expect(result.series.today[1]?.revenue).toBe(500);
    expect(result.topSource?.source).toBe("SHOPIFY");
    expect(result.topSource?.orders).toBe(1);
  });

  it("counts COD orders and source mix for the selected windows", () => {
    const result = aggregateAnalytics(
      [
        order("2026-09-20T11:00:00+05:30", {
          source: "SHOPIFY",
          payment_status: "COD",
          total_amount: 800,
        }),
        order("2026-09-20T11:30:00+05:30", {
          source: "SHOPIFY",
          payment_status: "PAID",
          total_amount: 200,
        }),
        order("2026-09-20T12:00:00+05:30", {
          source: "MANUAL",
          payment_status: "COD",
          total_amount: 100,
        }),
      ],
      [shipment("2026-09-20T11:05:00+05:30", { payment_mode: "COD", cod_amount: 800 })],
      NOW
    );

    expect(result.today.codOrders).toBe(2);
    expect(result.today.codAmount).toBe(900);
    expect(result.today.prepaidOrders).toBe(1);
    expect(result.today.prepaidAmount).toBe(200);
    expect(result.series.today[11]?.cod).toBe(1);
    expect(result.series.today[11]?.prepaid).toBe(1);
    expect(result.sources.today[0]?.source).toBe("SHOPIFY");
    expect(result.sources.today[0]?.share).toBeCloseTo(66.666, 2);
    expect(result.sources.today[1]?.source).toBe("MANUAL");
  });

  it("counts India Post booked COD and prepaid amounts by booked_at", () => {
    const result = aggregateAnalytics(
      [],
      [
        shipment("2026-09-20T01:00:00+05:30", {
          booked_at: "2026-09-20T02:00:00+05:30",
          payment_mode: "COD",
          cod_amount: 800,
        }),
        shipment("2026-09-20T01:30:00+05:30", {
          booked_at: "2026-09-20T03:00:00+05:30",
          payment_mode: "PREPAID",
          orders: { total_amount: 450 },
        }),
        shipment("2026-09-08T10:00:00+05:30", {
          booked_at: "2026-09-08T11:00:00+05:30",
          payment_mode: "PREPAID",
          orders: { total_amount: 200 },
        }),
        shipment("2026-09-20T04:00:00+05:30", {
          booked_at: null,
          payment_mode: "PREPAID",
          orders: { total_amount: 999 },
        }),
        shipment("2026-09-20T05:00:00+05:30", {
          booked_at: "2026-09-20T05:30:00+05:30",
          status: "CANCELLED",
          payment_mode: "COD",
          cod_amount: 50,
        }),
        shipment("2025-12-31T23:00:00+05:30", {
          booked_at: "2025-12-31T23:30:00+05:30",
          payment_mode: "COD",
          cod_amount: 75,
        }),
      ],
      NOW
    );

    expect(result.today.indiaPostBooked).toBe(2);
    expect(result.today.indiaPostCodBooked).toBe(1);
    expect(result.today.indiaPostCodAmount).toBe(800);
    expect(result.today.indiaPostPrepaidBooked).toBe(1);
    expect(result.today.indiaPostPrepaidAmount).toBe(450);
    expect(result.today.indiaPostBookedAmount).toBe(1250);
    expect(result.month.indiaPostBooked).toBe(3);
    expect(result.month.indiaPostPrepaidAmount).toBe(650);
    expect(result.year.indiaPostBooked).toBe(3);
    expect(result.series.today[2]?.indiaPostBooked).toBe(1);
    expect(result.series.today[2]?.indiaPostCodAmount).toBe(800);
    expect(result.series.today[3]?.indiaPostPrepaidAmount).toBe(450);
  });

  it("keeps yesterday separate from today, including the previous year", () => {
    const newYear = new Date("2026-01-01T10:00:00+05:30");
    const result = aggregateAnalytics(
      [
        order("2025-12-31T22:00:00+05:30", { total_amount: 40 }),
        order("2026-01-01T09:00:00+05:30", { total_amount: 10 }),
      ],
      [],
      newYear,
      false,
      { id: "yesterday" }
    );

    expect(result.today.orders).toBe(1);
    expect(result.today.revenue).toBe(10);
    expect(result.year.orders).toBe(1);
    expect(result.focus.id).toBe("yesterday");
    expect(result.focus.label).toBe("Yesterday");
    expect(result.focus.period.orders).toBe(1);
    expect(result.focus.period.revenue).toBe(40);
    expect(result.focus.series).toHaveLength(24);
    expect(result.focus.series[22]?.orders).toBe(1);
  });

  it("buckets a custom day by hour and a short span by day", () => {
    const single = aggregateAnalytics(
      [order("2026-09-18T04:00:00+05:30", { total_amount: 75, source: "MANUAL" })],
      [],
      NOW,
      false,
      { id: "custom", from: "2026-09-18", to: "2026-09-18" }
    );
    expect(single.focus.series).toHaveLength(24);
    expect(single.focus.series[4]?.revenue).toBe(75);
    expect(single.focus.period.orders).toBe(1);
    expect(single.today.orders).toBe(0);
    expect(single.focus.sources[0]?.source).toBe("MANUAL");

    const span = aggregateAnalytics(
      [
        order("2026-09-18T04:00:00+05:30", { total_amount: 75 }),
        order("2026-09-20T01:15:00+05:30", { total_amount: 25 }),
      ],
      [],
      NOW,
      false,
      { id: "custom", from: "2026-09-18", to: "2026-09-20" }
    );
    expect(span.focus.series).toHaveLength(3);
    expect(span.focus.series[0]?.revenue).toBe(75);
    expect(span.focus.series[2]?.revenue).toBe(25);
    expect(span.focus.period.revenue).toBe(100);
    expect(span.today.revenue).toBe(25);
  });

  it("rolls a long custom range into months", () => {
    const result = aggregateAnalytics(
      [
        order("2026-07-02T10:00:00+05:30", { total_amount: 30 }),
        order("2026-09-05T10:00:00+05:30", { total_amount: 70 }),
      ],
      [],
      NOW,
      false,
      { id: "custom", from: "2026-07-01", to: "2026-09-08" }
    );

    expect(inclusiveCalendarDays("2026-07-01", "2026-09-08")).toBe(70);
    expect(result.focus.series.map((point) => point.key)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(result.focus.series[0]?.revenue).toBe(30);
    expect(result.focus.series[2]?.revenue).toBe(70);
    expect(result.focus.period.orders).toBe(2);
  });
});

describe("analytics focus query", () => {
  it("defaults to today and rejects invalid custom ranges", () => {
    expect(parseAnalyticsFocus(new URLSearchParams(), NOW)).toEqual({ id: "today" });
    expect(parseAnalyticsFocus(new URLSearchParams("range=yesterday"), NOW)).toEqual({ id: "yesterday" });
    expect(parseAnalyticsFocus(new URLSearchParams("range=custom&from=2026-09-01&to=2026-09-20"), NOW)).toEqual({
      id: "custom",
      from: "2026-09-01",
      to: "2026-09-20",
    });
    expect(() => parseAnalyticsFocus(new URLSearchParams("range=custom&from=2026-09-20&to=2026-09-01"), NOW)).toThrow(
      /start is after/
    );
    expect(() => parseAnalyticsFocus(new URLSearchParams("range=custom&from=2026-09-21&to=2026-09-21"), NOW)).toThrow(
      /future/
    );
    expect(() => parseAnalyticsFocus(new URLSearchParams("range=custom&from=2026-02-31&to=2026-03-01"), NOW)).toThrow(
      /YYYY-MM-DD/
    );
    expect(() => parseAnalyticsFocus(new URLSearchParams("range=custom&from=2025-09-01&to=2026-09-20"), NOW)).toThrow(
      /365/
    );
  });

  it("fetches from the start of yesterday when that day is in the previous year", () => {
    const newYear = new Date("2026-01-01T10:00:00+05:30");
    expect(analyticsFetchSince(newYear, { id: "yesterday" })).toBe(istDayStartIso("2025-12-31"));
    expect(analyticsFetchSince(NOW, { id: "today" })).toBe(startOfIstYearIso(NOW));
  });
});
