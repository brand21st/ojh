import { PostHog } from "posthog-node";
import { POSTHOG_DEFAULT_HOST, serverErrorTrackingDecision } from "@/lib/analytics/posthog-shared";

export { serverErrorTrackingDecision } from "@/lib/analytics/posthog-shared";

let posthogServer: PostHog | null = null;

export function getPostHogServer(): PostHog | null {
  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?.trim();
  const decision = serverErrorTrackingDecision({
    token,
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    nodeEnv: process.env.NODE_ENV,
    runtime: process.env.NEXT_RUNTIME,
    pathname: "/",
  });
  if (!decision.enabled || !token) return null;

  posthogServer ??= new PostHog(token, {
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || POSTHOG_DEFAULT_HOST,
    flushAt: 1,
    flushInterval: 0,
    enableExceptionAutocapture: process.env.NEXT_RUNTIME === "nodejs",
  });
  return posthogServer;
}

/** Handled server errors. No-ops in local `next dev`, tests, and when there is no token. */
export function captureServerException(
  error: unknown,
  distinctId?: string,
  additionalProperties?: Record<string, unknown>,
): boolean {
  const client = getPostHogServer();
  if (!client) return false;
  client.captureException(error, distinctId, additionalProperties);
  return true;
}

/** Same as `captureServerException`, flushed before `after()` callbacks return. */
export async function captureServerExceptionImmediate(
  error: unknown,
  distinctId?: string,
  additionalProperties?: Record<string, unknown>,
): Promise<boolean> {
  const client = getPostHogServer();
  if (!client) return false;
  await client.captureExceptionImmediate(error, distinctId, additionalProperties);
  return true;
}
