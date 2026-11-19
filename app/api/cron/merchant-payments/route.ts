import { NextResponse, type NextRequest } from "next/server";
import { authorizeCron } from "@/lib/jobs/cron-auth";
import { logError } from "@/lib/logger";
import { createAdminClient, hasAdminClient } from "@/lib/supabase/admin";
import { sweepOpenStorefrontPayments } from "@/modules/merchant-payments/payments";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Reconciles merchant storefront payments whose browser callback and webhook were both missed.
 * Separate from /api/cron/billing so SaaS billing and merchant payments never share a sweep.
 */
export async function POST(request: NextRequest) {
  const auth = authorizeCron(request.headers);
  if (!auth.authorized) {
    return NextResponse.json({ success: false, message: auth.reason }, { status: 401 });
  }
  if (!hasAdminClient()) {
    return NextResponse.json({ success: false, message: "Service role is not configured." }, { status: 503 });
  }
  try {
    const result = await sweepOpenStorefrontPayments(createAdminClient());
    return NextResponse.json({ success: true, data: result });
  } catch {
    logError("merchant_payments.sweep_failed", {});
    return NextResponse.json({ success: false, message: "Merchant payment sweep failed." }, { status: 500 });
  }
}
