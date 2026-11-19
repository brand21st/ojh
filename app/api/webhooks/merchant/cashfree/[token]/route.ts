import { NextResponse, type NextRequest } from "next/server";
import { logError } from "@/lib/logger";
import { createAdminClient, hasAdminClient } from "@/lib/supabase/admin";
import { handleMerchantCashfreeWebhook } from "@/modules/merchant-payments/cashfree/webhook";

export const dynamic = "force-dynamic";

/**
 * Merchant storefront Cashfree webhooks (one URL per merchant integration; also sent to Cashfree
 * as each order's notify_url). Independent of the PostBus SaaS billing webhook.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  // Raw text: Cashfree signs the exact bytes it sent (timestamp + raw body).
  const rawBody = await request.text();
  if (!hasAdminClient()) {
    return NextResponse.json({ success: false, message: "Server is not configured." }, { status: 503 });
  }
  try {
    const outcome = await handleMerchantCashfreeWebhook(createAdminClient(), {
      token,
      rawBody,
      signature: request.headers.get("x-webhook-signature") ?? "",
      timestamp: request.headers.get("x-webhook-timestamp") ?? "",
      idempotencyKey: request.headers.get("x-idempotency-key"),
    });
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch {
    logError("merchant_cashfree.webhook_unhandled", {});
    return NextResponse.json({ success: false, message: "Webhook processing failed." }, { status: 500 });
  }
}
