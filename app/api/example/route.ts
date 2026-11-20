import { SeverityNumber } from "@opentelemetry/api";
import { loggerProvider } from "@/lib/observability/otel-logs";

export const runtime = "nodejs";

const logger = loggerProvider.getLogger("postbus");

export async function GET() {
  logger.emit({
    body: "API request received",
    severityNumber: SeverityNumber.INFO,
    attributes: {
      endpoint: "/api/example",
      method: "GET",
    },
  });

  await loggerProvider.forceFlush();
  return Response.json({ success: true });
}
