import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TenantContext } from "@/lib/api/context";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { manifestCsv, manifestFileBase, manifestXlsx } from "@/modules/manifests/export";
import { manifestExportErrorCount, validateManifestExport } from "@/modules/manifests/validate-export";
import { exportManifestIndiaPostExcel } from "@/modules/manifests/india-post-excel";
import { renderManifestPdf } from "@/modules/manifests/pdf";
import {
  manifestAddBody,
  manifestExportFormat,
  manifestHandoverBody,
  manifestListQuery,
} from "@/modules/manifests/schema";
import {
  addShipments,
  closeManifest,
  enqueueFulfillmentForManifested,
  getManifest,
  getManifestSender,
  listEligible,
  listManifests,
  manifestProofUrl,
  markHandedOver,
  removeShipment,
  reopenManifest,
  sweepEligible,
} from "@/modules/manifests/service";
import {
  listManifestEmailDeliveries,
  retryManifestEmail,
  sendManifestEmail,
} from "@/modules/manifest-email/service";
import { getManifestEmailSettings, updateManifestEmailSettings } from "@/modules/manifest-email/settings";

async function readHandover(request: NextRequest) {
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("multipart/form-data")) {
    return { ...manifestHandoverBody.parse(await request.json().catch(() => ({}))), proof: null };
  }
  const form = await request.formData();
  const body = manifestHandoverBody.parse({
    handedOverTo: form.get("handedOverTo") ?? undefined,
    notes: form.get("notes") ?? undefined,
  });
  const file = form.get("proof");
  if (!file || typeof file === "string" || file.size === 0) return { ...body, proof: null };
  return { ...body, proof: { bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type } };
}

export async function handleManifestRoutes(
  request: NextRequest,
  supabase: SupabaseClient,
  ctx: TenantContext,
  method: string,
  slugs: string[]
) {
  if (slugs[0] !== "manifests") return null;
  const [, id, action, childId, extra] = slugs;
  const org = ctx.organizationId;

  if (!id) {
    if (method === "GET") {
      return listManifests(supabase, org, manifestListQuery.parse(Object.fromEntries(request.nextUrl.searchParams)));
    }
    if (method === "POST") {
      const result = await sweepEligible(supabase, org, { userId: ctx.userId });
      await enqueueFulfillmentForManifested(supabase, org, result.added);
      return { added: result.added.length, manifestIds: result.manifestIds };
    }
    return null;
  }

  if (id === "eligible" && !action && method === "GET") {
    return listEligible(supabase, org);
  }

  if (id === "email-settings" && !action && method === "GET") {
    return getManifestEmailSettings(supabase, org);
  }
  if (id === "email-settings" && !action && method === "PATCH") {
    return updateManifestEmailSettings(supabase, org, ctx.userId, await request.json().catch(() => ({})));
  }

  if (!action && method === "GET") return getManifest(supabase, org, id);

  if (action === "shipments" && !childId && method === "POST") {
    const body = manifestAddBody.parse(await request.json().catch(() => ({})));
    return addShipments(supabase, org, id, body.shipmentIds, ctx.userId);
  }
  if (action === "shipments" && childId && method === "DELETE") {
    return removeShipment(supabase, org, id, childId, ctx.userId);
  }
  if (action === "email" && method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { recipients?: unknown; confirmResend?: boolean };
    return sendManifestEmail(supabase, org, id, ctx.userId, body);
  }
  if (action === "email-deliveries" && !childId && method === "GET") {
    return listManifestEmailDeliveries(supabase, org, id);
  }
  if (action === "email-deliveries" && childId && extra === "retry" && method === "POST") {
    return retryManifestEmail(supabase, org, id, childId, ctx.userId);
  }

  if (action === "close" && method === "POST") return closeManifest(supabase, org, id, ctx.userId);
  if (action === "reopen" && method === "POST") return reopenManifest(supabase, org, id, ctx.userId);
  if (action === "handover" && method === "POST") {
    return markHandedOver(supabase, org, id, await readHandover(request), ctx.userId);
  }

  if (action === "proof" && method === "GET") {
    return NextResponse.redirect(await manifestProofUrl(supabase, org, id));
  }

  if (action === "india-post-excel" && method === "GET") {
    const file = await exportManifestIndiaPostExcel(supabase, org, id);
    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${file.filename}"`,
      },
    });
  }

  if (action === "export-validation" && method === "GET") {
    const manifest = await getManifest(supabase, org, id);
    const sender = await getManifestSender(supabase, org);
    const issues = validateManifestExport(manifest, sender);
    return {
      issues,
      errorCount: manifestExportErrorCount(issues),
      warningCount: issues.filter((item) => item.severity === "warning").length,
    };
  }

  if (action === "export" && method === "GET") {
    const parsed = manifestExportFormat.safeParse(request.nextUrl.searchParams.get("format") ?? undefined);
    if (!parsed.success) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Choose xlsx, csv or pdf.");
    const manifest = await getManifest(supabase, org, id);
    const sender = await getManifestSender(supabase, org);
    if (parsed.data !== "pdf") {
      const issues = validateManifestExport(manifest, sender);
      if (manifestExportErrorCount(issues) > 0) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          "Fix the listed shipments before downloading this handover file.",
          { issues }
        );
      }
    }
    const base = manifestFileBase(manifest);
    if (parsed.data === "csv") {
      return new NextResponse(manifestCsv(manifest, sender), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${base}.csv"`,
        },
      });
    }
    if (parsed.data === "pdf") {
      const bytes = await renderManifestPdf(manifest, sender);
      return new NextResponse(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${base}.pdf"`,
        },
      });
    }
    return new NextResponse(new Uint8Array(await manifestXlsx(manifest, sender)), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${base}.xlsx"`,
      },
    });
  }

  return null;
}
