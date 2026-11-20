import * as Sentry from "@sentry/nextjs";
import { createOnRequestError } from "@posthog/next";
import { isClientAbortedRscStream, requestPathname, serverErrorTrackingDecision } from "@/lib/analytics/posthog-shared";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    const { getPostHogServer } = await import("@/lib/analytics/posthog-server");
    getPostHogServer();
    const { registerOtelLogs } = await import("./lib/observability/otel-logs");
    registerOtelLogs();
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

const posthogOnRequestError = createOnRequestError({
  apiKey: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
});

export async function onRequestError(
  ...args: Parameters<typeof Sentry.captureRequestError>
) {
  if (isClientAbortedRscStream(args[0])) return;
  await Sentry.captureRequestError(...args);
  const [, request] = args;
  const path = typeof request?.path === "string" ? request.path : "/";
  const decision = serverErrorTrackingDecision({
    token: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    nodeEnv: process.env.NODE_ENV,
    runtime: process.env.NEXT_RUNTIME,
    pathname: requestPathname(path),
  });
  if (!decision.enabled) return;
  await posthogOnRequestError(...args);
}
