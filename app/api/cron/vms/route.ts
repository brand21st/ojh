import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { env } from "@/lib/env";
import { authorizeCron } from "@/lib/jobs/cron-auth";
import { logError } from "@/lib/logger";
import { hasAdminClient } from "@/lib/supabase/admin";
import { expireVideos } from "@/modules/vms/service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Packing video retention: deletes files past their expiry and abandoned recordings. Run hourly. */
export async function POST(request: NextRequest) {
  const auth = authorizeCron(request.headers);
  if (!auth.authorized) {
    return NextResponse.json({ success: false, message: auth.reason }, { status: 401 });
  }
  if (!env.vmsEnabled || !hasAdminClient()) {
    return NextResponse.json({ success: true, data: { skipped: true } });
  }
  try {
    return NextResponse.json({ success: true, data: await expireVideos(500) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    logError("vms.cron_failed", { message });
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
