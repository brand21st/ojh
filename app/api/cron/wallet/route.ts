import { NextResponse, type NextRequest } from "next/server";
import { authorizeCron } from "@/lib/jobs/cron-auth";
import { logError } from "@/lib/logger";
import { createAdminClient, hasAdminClient } from "@/lib/supabase/admin";
import { walletEnabled } from "@/modules/wallet/constants";
import { runWalletSweep } from "@/modules/wallet/reconcile";

export const dynamic = "force-dynamic";

/** Every few minutes: free expired holds, recover missed recharges, reconcile balances. */
export async function POST(request: NextRequest) {
  const auth = authorizeCron(request.headers);
  if (!auth.authorized) {
    return NextResponse.json({ success: false, message: auth.reason }, { status: 401 });
  }
  if (!walletEnabled()) {
    return NextResponse.json({ success: true, data: { skipped: "wallet disabled" } });
  }
  if (!hasAdminClient()) {
    return NextResponse.json({ success: false, message: "Service role is not configured." }, { status: 503 });
  }
  try {
    const result = await runWalletSweep(createAdminClient());
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Wallet sweep failed.";
    logError("wallet.cron_failed", { message });
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
