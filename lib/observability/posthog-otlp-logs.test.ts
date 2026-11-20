import { describe, expect, it } from "vitest";
import { posthogOtlpLogsConfig, posthogOtlpLogsUrl } from "@/lib/observability/posthog-otlp-logs";

describe("posthogOtlpLogsUrl", () => {
  it("appends /i/v1/logs and the token query on the default US host", () => {
    expect(posthogOtlpLogsUrl(undefined, "phc_test")).toBe(
      "https://us.i.posthog.com/i/v1/logs?token=phc_test",
    );
  });

  it("strips a trailing slash on a custom host", () => {
    expect(posthogOtlpLogsUrl("https://eu.i.posthog.com/", "phc_eu")).toBe(
      "https://eu.i.posthog.com/i/v1/logs?token=phc_eu",
    );
  });
});

describe("posthogOtlpLogsConfig", () => {
  it("returns null without a token", () => {
    expect(posthogOtlpLogsConfig({ token: "  ", host: undefined })).toBeNull();
  });

  it("puts the token on the URL and only sets JSON content type", () => {
    expect(posthogOtlpLogsConfig({ token: " phc_test \n", host: "https://us.i.posthog.com" })).toEqual({
      url: "https://us.i.posthog.com/i/v1/logs?token=phc_test",
      headers: {
        "Content-Type": "application/json",
      },
    });
  });
});
