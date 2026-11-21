import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { logError, logInfo } from "@/lib/logger";
import { renderWalletInvoicePdf } from "@/modules/wallet/invoice-pdf";
import { isMissingRelation } from "@/modules/wallet/recharge";

export type InvoiceIssueStatus =
  | "ISSUED"
  | "DUPLICATE"
  | "NOT_PAID"
  | "NOT_FOUND"
  | "SUPPLIER_INCOMPLETE"
  | "CUSTOMER_INCOMPLETE"
  | "UNAVAILABLE";

/**
 * Issues the tax invoice for a paid recharge. Never throws: the wallet is
 * already credited, and an invoice that cannot be issued yet is retried by
 * the wallet cron once the missing details are filled in.
 */
export async function issueRechargeInvoice(db: SupabaseClient, rechargeOrderId: string) {
  const { data, error } = await db.rpc("wallet_issue_recharge_invoice", { p_recharge_order_id: rechargeOrderId });
  if (error) {
    if (!isMissingRelation(error) && error.code !== "PGRST202") {
      logError("wallet.invoice_issue_failed", { rechargeOrderId, message: error.message });
    }
    return { status: "UNAVAILABLE" as InvoiceIssueStatus, invoiceNumber: null, reason: error.message };
  }
  const raw = (data ?? {}) as Record<string, unknown>;
  const status = String(raw.status ?? "UNAVAILABLE") as InvoiceIssueStatus;
  if (status === "ISSUED") logInfo("wallet.invoice_issued", { rechargeOrderId, invoiceNumber: raw.invoiceNumber });
  if (status === "SUPPLIER_INCOMPLETE" || status === "CUSTOMER_INCOMPLETE") {
    logInfo("wallet.invoice_waiting", { rechargeOrderId, status, reason: raw.reason });
  }
  return {
    status,
    invoiceNumber: typeof raw.invoiceNumber === "string" ? raw.invoiceNumber : null,
    reason: typeof raw.reason === "string" ? raw.reason : null,
  };
}

/** Cron: issue every paid recharge that still has no invoice. */
export async function issuePendingRechargeInvoices(db: SupabaseClient, limit = 100) {
  const { data, error } = await db.rpc("wallet_recharges_missing_invoice", { p_limit: limit });
  if (error) {
    if (!isMissingRelation(error) && error.code !== "PGRST202") {
      logError("wallet.invoice_pending_list_failed", { message: error.message });
    }
    return { checked: 0, issued: 0, waiting: 0 };
  }
  const ids = ((data ?? []) as unknown[]).map((row) =>
    typeof row === "string" ? row : String((row as Record<string, unknown>).wallet_recharges_missing_invoice ?? row)
  );
  let issued = 0;
  let waiting = 0;
  for (const id of ids) {
    const result = await issueRechargeInvoice(db, id);
    if (result.status === "ISSUED") issued += 1;
    else if (result.status !== "DUPLICATE") waiting += 1;
    // Supplier details are platform-wide: if they are missing, every other order waits too.
    if (result.status === "SUPPLIER_INCOMPLETE") break;
  }
  return { checked: ids.length, issued, waiting };
}

/** The issued invoice as a PDF, only for the tenant that owns the recharge. */
export async function rechargeInvoicePdf(db: SupabaseClient, organizationId: string, rechargeOrderId: string) {
  const { data, error } = await db
    .from("wallet_recharge_invoices")
    .select(
      "invoice_number, issued_at, paid_at, supplier_legal_name, supplier_address, supplier_gstin, customer_legal_name, customer_address, customer_gstin, place_of_supply, supplier_state_code, customer_state_code, sac, description, gst_rate_bps, gross_paise::text, taxable_paise::text, cgst_paise::text, sgst_paise::text, igst_paise::text, total_tax_paise::text, payment_reference, wallet_recharge_orders(refunded_paise)"
    )
    .eq("recharge_order_id", rechargeOrderId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) {
    logError("wallet.invoice_load_failed", { message: error.message, organizationId });
    throw new AppError(ERROR_CODES.JOB_FAILED, "Could not load the invoice.");
  }
  if (!data) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "This recharge has no invoice yet.");

  const order = Array.isArray(data.wallet_recharge_orders) ? data.wallet_recharge_orders[0] : data.wallet_recharge_orders;
  const bytes = await renderWalletInvoicePdf({
    invoiceNumber: String(data.invoice_number),
    issuedAt: String(data.issued_at),
    paidAt: (data.paid_at as string | null) ?? null,
    supplierLegalName: String(data.supplier_legal_name),
    supplierAddress: String(data.supplier_address),
    supplierGstin: String(data.supplier_gstin),
    customerLegalName: String(data.customer_legal_name),
    customerAddress: String(data.customer_address ?? ""),
    customerGstin: String(data.customer_gstin ?? ""),
    placeOfSupply: data.place_of_supply === "INTER" ? "INTER" : "INTRA",
    supplierStateCode: (data.supplier_state_code as string | null) ?? null,
    customerStateCode: (data.customer_state_code as string | null) ?? null,
    sac: String(data.sac ?? ""),
    description: String(data.description),
    gstRateBps: Number(data.gst_rate_bps),
    grossPaise: BigInt(String(data.gross_paise)),
    taxablePaise: BigInt(String(data.taxable_paise)),
    cgstPaise: BigInt(String(data.cgst_paise)),
    sgstPaise: BigInt(String(data.sgst_paise)),
    igstPaise: BigInt(String(data.igst_paise)),
    totalTaxPaise: BigInt(String(data.total_tax_paise)),
    paymentReference: (data.payment_reference as string | null) ?? null,
    refundedPaise: BigInt(Number((order as { refunded_paise?: number } | null)?.refunded_paise ?? 0)),
  });
  const filename = String(data.invoice_number).replace(/[^A-Za-z0-9-]/g, "-");
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
