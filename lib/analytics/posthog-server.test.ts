import { afterEach, describe, expect, it, vi } from "vitest";

const captureException = vi.fn();
const PostHog = vi.fn(function PostHogMock() {
  return { captureException };
});
vi.mock("posthog-node", () => ({ PostHog }));

import { requestPathname, serverErrorTrackingDecision } from "./posthog-shared";

const prod = {
  token: "phc_test",
  host: "https://us.i.posthog.com",
  nodeEnv: "production",
  runtime: "nodejs",
  pathname: "/dashboard",
};

describe("serverErrorTrackingDecision", () => {
  it("enables in production", () => {
    expect(serverErrorTrackingDecision(prod)).toEqual({ enabled: true });
  });

  it.each([undefined, "", "   "])("stays off without a token (%j)", (token) => {
    expect(serverErrorTrackingDecision({ ...prod, token })).toEqual({ enabled: false, reason: "no-token" });
  });

  it.each(["development", "test", undefined])("stays off outside production (%j)", (nodeEnv) => {
    expect(serverErrorTrackingDecision({ ...prod, nodeEnv })).toEqual({ enabled: false, reason: "local-dev" });
  });

  it.each(["/shopify", "/shopify/orders?shop=x.myshopify.com"])("stays off inside Shopify Admin (%s)", (pathname) => {
    expect(serverErrorTrackingDecision({ ...prod, pathname })).toEqual({ enabled: false, reason: "shopify-embedded" });
  });
});

describe("requestPathname", () => {
  it("strips the query string", () => {
    expect(requestPathname("/api/v1/orders?id=1")).toBe("/api/v1/orders");
  });
});

describe("getPostHogServer", () => {
  afterEach(() => {
    vi.resetModules();
    PostHog.mockReset();
  });

  it("does not construct a client during tests", async () => {
    const { getPostHogServer, captureServerException } = await import("./posthog-server");
    expect(getPostHogServer()).toBeNull();
    expect(PostHog).not.toHaveBeenCalled();
    expect(captureServerException(new Error("This is a test exception for error tracking"), "user_distinct_id", { source: "test" })).toBe(
      false,
    );
    expect(captureException).not.toHaveBeenCalled();
  });
});
