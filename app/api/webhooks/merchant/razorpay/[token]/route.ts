import { NextResponse, type NextRequest } from "next/server";
import { logError } from "@/lib/logger";
import { createAdminClient, hasAdminClient } from "@/lib/supabase/admin";
import { handleMerchantRazorpayWebhook } from "@/modules/merchant-payments/webhook";

export const dynamic = "force-dynamic";

/**
 * Merchant storefront payment webhooks (one URL per merchant integration).
 * Independent of the PostBus SaaS billing webhook at /api/webhooks/razorpay.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  // Raw text: the signature covers the exact bytes Razorpay sent.
  const rawBody = await request.text();
  if (!hasAdminClient()) {
    return NextResponse.json({ success: false, message: "Server is not configured." }, { status: 503 });
  }
  try {
    const outcome = await handleMerchantRazorpayWebhook(createAdminClient(), {
      token,
      rawBody,
      signature: request.headers.get("x-razorpay-signature") ?? "",
      eventId: request.headers.get("x-razorpay-event-id"),
    });
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch {
    logError("merchant_razorpay.webhook_unhandled", {});
    return NextResponse.json({ success: false, message: "Webhook processing failed." }, { status: 500 });
  }
}
