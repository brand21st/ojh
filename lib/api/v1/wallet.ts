import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import type { TenantContext } from "@/lib/api/context";
import { UTF8_BOM, toCsv } from "@/lib/csv";
import { createAdminClient, hasAdminClient } from "@/lib/supabase/admin";
import { hasPermission } from "@/lib/permissions/rbac";
import { walletEnabled } from "@/modules/wallet/constants";
import { getWalletOverview, listRechargeOrders, listWalletTransactions, walletDailyUsage, walletStatementRows } from "@/modules/wallet/read";
import { loadRechargeLimits, previewRecharge, startWalletRecharge, verifyWalletRecharge } from "@/modules/wallet/recharge";
import { recoverPendingRecharges } from "@/modules/wallet/reconcile";
import { rechargeInvoicePdf } from "@/modules/wallet/invoices";

const TRANSACTION_TYPES = ["all", "recharge", "whatsapp", "ai", "credits"] as const;

function clientIp(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

/** Wallet reads and writes always use the service role, scoped to ctx.organizationId. */
function walletDb(): SupabaseClient {
  if (!hasAdminClient()) {
    throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Wallet requires the service role.");
  }
  return createAdminClient();
}

function assertOpen() {
  if (!walletEnabled()) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Not found.");
}

export async function handleWalletRoutes(
  request: NextRequest,
  ctx: TenantContext,
  key: string
) {
  if (key !== "GET wallet" && !key.startsWith("GET wallet/") && !key.startsWith("POST wallet/") && !key.startsWith("PATCH wallet/")) return null;
  assertOpen();
  const db = walletDb();
  const params = request.nextUrl.searchParams;

  if (key === "GET wallet") {
    // A merchant opening the page is also a chance to recover a missed webhook.
    await recoverPendingRecharges(db, { organizationId: ctx.organizationId, limit: 5 }).catch(() => undefined);
    const [overview, limits] = await Promise.all([getWalletOverview(db, ctx.organizationId), loadRechargeLimits(db)]);
    return { ...overview, recharge: limits, canRecharge: hasPermission(ctx.role, "org.billing") };
  }

  if (key === "GET wallet/transactions") {
    const type = z.enum(TRANSACTION_TYPES).catch("all").parse(params.get("type") ?? "all");
    return listWalletTransactions(db, ctx.organizationId, {
      page: Number(params.get("page") ?? 1),
      pageSize: Number(params.get("pageSize") ?? 20),
      type,
    });
  }

  if (key === "GET wallet/recharges") {
    return listRechargeOrders(db, ctx.organizationId, {
      page: Number(params.get("page") ?? 1),
      pageSize: Number(params.get("pageSize") ?? 20),
    });
  }

  const invoiceMatch = /^GET wallet\/recharges\/([0-9a-f-]{36})\/invoice$/i.exec(key);
  if (invoiceMatch) {
    return rechargeInvoicePdf(db, ctx.organizationId, invoiceMatch[1]);
  }

  if (key === "GET wallet/usage") {
    return { days: await walletDailyUsage(db, ctx.organizationId, Number(params.get("days") ?? 30)) };
  }

  if (key === "GET wallet/statement") {
    const range = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .safeParse({ from: params.get("from"), to: params.get("to") });
    if (!range.success) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Choose a from and to date.");
    const rows = await walletStatementRows(db, ctx.organizationId, range.data);
    const body = UTF8_BOM + toCsv(rows);
    return new NextResponse(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="postbus-wallet-${range.data.from}-to-${range.data.to}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (key === "PATCH wallet/alerts") {
    const body = z
      .object({ thresholdsRupees: z.array(z.number().int().min(1).max(100000)).max(5) })
      .parse(await request.json());
    const { data, error } = await db.rpc("wallet_set_thresholds", {
      p_org: ctx.organizationId,
      p_thresholds_micros: body.thresholdsRupees.map((rupees) => String(BigInt(rupees) * BigInt(1_000_000))),
    });
    if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Could not save alert levels.");
    return data;
  }

  if (key === "POST wallet/recharge/preview") {
    const body = z.object({ amountPaise: z.number().int() }).parse(await request.json());
    return previewRecharge(body.amountPaise, await loadRechargeLimits(db));
  }

  if (key === "POST wallet/recharge") {
    const body = z.object({ amountPaise: z.number().int() }).parse(await request.json());
    return startWalletRecharge(db, {
      organizationId: ctx.organizationId,
      organizationName: ctx.organizationName,
      email: ctx.email,
      userId: ctx.userId,
      amountPaise: body.amountPaise,
      ip: clientIp(request),
    });
  }

  if (key === "POST wallet/recharge/verify") {
    const body = z
      .object({
        razorpayOrderId: z.string().min(1).max(64),
        razorpayPaymentId: z.string().min(1).max(64),
        razorpaySignature: z.string().min(1).max(256),
      })
      .parse(await request.json());
    return verifyWalletRecharge(db, {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      razorpayOrderId: body.razorpayOrderId,
      razorpayPaymentId: body.razorpayPaymentId,
      signature: body.razorpaySignature,
      ip: clientIp(request),
    });
  }

  throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Not found.");
}
