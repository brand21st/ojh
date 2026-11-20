import { NextResponse, type NextRequest } from "next/server";
import { logError } from "@/lib/logger";
import { createAdminClient, hasAdminClient } from "@/lib/supabase/admin";
import { verifyWebhookSignature } from "@/modules/razorpay/signature";
import { settlementEvent } from "@/modules/affiliates/razorpayx";

export const dynamic = "force-dynamic";

type PayoutEntity = { id?: string; status?: string; utr?: string | null; failure_reason?: string | null; status_details?: { description?: string } | null };

/**
 * RazorpayX payout webhook (payout.processed / failed / rejected / reversed / updated).
 * Signed with RAZORPAYX_WEBHOOK_SECRET. Settlement is idempotent in the database, so
 * Razorpay's retries and out-of-order deliveries are safe.
 */
export async function POST(request: NextRequest) {
  const raw = await request.text();
  const secret = process.env.RAZORPAYX_WEBHOOK_SECRET?.trim();
  if (!secret) return NextResponse.json({ success: false, message: "Webhook secret is not configured." }, { status: 503 });
  if (!verifyWebhookSignature(raw, request.headers.get("x-razorpay-signature") ?? "", secret)) {
    return NextResponse.json({ success: false, message: "Invalid webhook signature." }, { status: 400 });
  }
  if (!hasAdminClient()) return NextResponse.json({ success: false, message: "Server is not configured." }, { status: 503 });

  let body: { event?: string; payload?: { payout?: { entity?: PayoutEntity } } };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ success: false, message: "Invalid JSON." }, { status: 400 });
  }
  const entity = body.payload?.payout?.entity;
  if (!body.event?.startsWith("payout.") || !entity?.id) return NextResponse.json({ success: true, ignored: true });

  // Trust the entity's status over the event name: payout.updated carries the new status.
  const event = settlementEvent(String(entity.status ?? "")) ?? settlementEvent(body.event.slice("payout.".length));
  if (!event) return NextResponse.json({ success: true, ignored: true });

  const { data, error } = await createAdminClient().rpc("affiliate_provider_settle", {
    p_provider_id: entity.id,
    p_event: event,
    p_utr: entity.utr ?? "",
    p_reason: entity.failure_reason || entity.status_details?.description || "",
  });
  if (error) {
    logError("affiliate.payout_webhook_failed", { event: body.event });
    return NextResponse.json({ success: false, message: "Could not record payout status." }, { status: 500 });
  }
  return NextResponse.json({ success: true, status: data });
}
