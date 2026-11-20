import { beforeEach, describe, expect, it, vi } from "vitest";

const emit = vi.fn();
const forceFlush = vi.fn().mockResolvedValue(undefined);

vi.mock("@opentelemetry/api", () => ({
  SeverityNumber: { INFO: 9 },
}));

vi.mock("@/lib/observability/otel-logs", () => ({
  loggerProvider: {
    getLogger: () => ({ emit }),
    forceFlush,
  },
}));

describe("GET /api/example", () => {
  beforeEach(() => {
    emit.mockClear();
    forceFlush.mockClear();
  });

  it("emits a log, flushes, then returns success", async () => {
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "API request received",
        severityNumber: 9,
        attributes: { endpoint: "/api/example", method: "GET" },
      }),
    );
    expect(emit).toHaveBeenCalledBefore(forceFlush);
  });
});
