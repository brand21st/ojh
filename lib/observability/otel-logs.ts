import { logs } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { serverErrorTrackingDecision } from "@/lib/analytics/posthog-shared";
import { posthogOtlpLogsConfig } from "@/lib/observability/posthog-otlp-logs";

function createLoggerProvider() {
  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  const tracking = serverErrorTrackingDecision({
    token,
    host,
    nodeEnv: process.env.NODE_ENV,
    runtime: process.env.NEXT_RUNTIME,
    pathname: "/",
  });
  const otlp = tracking.enabled ? posthogOtlpLogsConfig({ token, host }) : null;

  return new LoggerProvider({
    resource: resourceFromAttributes({ "service.name": "postbus" }),
    processors: otlp
      ? [
          new BatchLogRecordProcessor({
            exporter: new OTLPLogExporter({
              url: otlp.url,
              headers: otlp.headers,
            }),
          }),
        ]
      : [],
  });
}

/** Node-only. Import from route handlers to forceFlush() after emitting logs. */
export const loggerProvider = createLoggerProvider();

export function registerOtelLogs() {
  logs.setGlobalLoggerProvider(loggerProvider);
}

export async function flushOtelLogs() {
  await loggerProvider.forceFlush();
}
