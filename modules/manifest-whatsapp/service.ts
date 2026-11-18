import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { logError } from "@/lib/logger";
import { hasAdminClient, createAdminClient } from "@/lib/supabase/admin";
import { createBackgroundJob } from "@/modules/jobs/service";
import { indiaPostExcelFilename } from "@/modules/manifests/india-post-excel";
import { probeVachatMe } from "@/modules/vachat/service";
import { resolveVachatSendCredentials } from "@/modules/vachat/platform-config";
import { manifestWhatsAppEnabled } from "@/modules/manifest-whatsapp/config";
import { chunkFiles, MANIFEST_WHATSAPP_MAX_FILES_PER_BATCH } from "@/modules/manifest-whatsapp/batch";
import {
  autoIdempotencyKey,
  manualIdempotencyKey,
  normalizeWhatsAppRecipients,
  resolveManifestWhatsAppRecipients,
  type WhatsAppRecipient,
} from "@/modules/manifest-whatsapp/recipients";
import { readManifestWhatsAppSettings } from "@/modules/manifest-whatsapp/settings";
import { mapDelivery } from "@/modules/manifest-whatsapp/store";
import { toPublicDelivery } from "@/modules/manifest-whatsapp/types";

type ManifestSource = {
  id: string;
  status: string;
  manifest_number: string | null;
  manifest_date: string;
  office_id: string | null;
  office_name: string | null;
  shipment_count: number;
  closed_at: string | null;
};

const ACTIVE_JOB = ["QUEUED", "RUNNING", "RETRYING", "PENDING"];

function writer(supabase: SupabaseClient) {
  return hasAdminClient() ? createAdminClient() : supabase;
}

async function merchantName(supabase: SupabaseClient, organizationId: string) {
  const { data } = await supabase.from("organizations").select("name").eq("id", organizationId).maybeSingle();
  return String(data?.name ?? "Merchant").replace(/[\r\n]+/g, " ").trim().slice(0, 200) || "Merchant";
}

async function loadManifest(supabase: SupabaseClient, organizationId: string, manifestId: string) {
  const { data, error } = await supabase
    .from("manifests")
    .select("id, status, manifest_number, manifest_date, office_id, office_name, shipment_count, closed_at")
    .eq("organization_id", organizationId)
    .eq("id", manifestId)
    .maybeSingle();
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  if (!data) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Manifest not found.");
  return data as ManifestSource;
}

async function attachJob(
  supabase: SupabaseClient,
  organizationId: string,
  deliveryId: string,
  userId?: string | null
) {
  const db = writer(supabase);
  const job = await createBackgroundJob(db, {
    organizationId,
    jobType: "manifest-whatsapp",
    entityType: "manifest_whatsapp_delivery",
    entityId: deliveryId,
    userId: userId ?? undefined,
    progress: { deliveryId },
  });
  await db
    .from("manifest_whatsapp_deliveries")
    .update({
      background_job_id: job.id,
      status: "QUEUED",
      queued_at: new Date().toISOString(),
    })
    .eq("id", deliveryId)
    .eq("organization_id", organizationId);
  return job.id as string;
}

async function insertDelivery(supabase: SupabaseClient, row: Record<string, unknown>, userId?: string | null) {
  const db = writer(supabase);
  const { data, error } = await db.from("manifest_whatsapp_deliveries").insert(row).select("*").maybeSingle();
  if (error?.code === "23505") {
    const { data: existing } = await db
      .from("manifest_whatsapp_deliveries")
      .select("*")
      .eq("idempotency_key", row.idempotency_key)
      .maybeSingle();
    if (!existing) throw new AppError(ERROR_CODES.CONFLICT, "This WhatsApp delivery is already queued.");
    const mapped = mapDelivery(existing);
    if (mapped.status === "QUEUED" && !mapped.backgroundJobId) {
      await attachJob(supabase, mapped.organizationId, mapped.id, userId);
    }
    return { delivery: mapped, created: false };
  }
  if (error || !data) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error?.message || "Could not save the WhatsApp delivery.");
  return { delivery: mapDelivery(data), created: true };
}

function snapshot(input: {
  organizationId: string;
  manifest: ManifestSource;
  merchant: string;
  recipient: WhatsAppRecipient;
  trigger: "AUTO" | "MANUAL";
  idempotencyKey: string;
  batchId: string;
  batchIndex: number;
  batchCount: number;
  fileIndex: number;
  userId?: string | null;
  status: "QUEUED" | "FAILED";
  lastError?: string;
  lastErrorCode?: string;
}) {
  return {
    organization_id: input.organizationId,
    manifest_id: input.manifest.id,
    trigger_type: input.trigger,
    manifest_closed_at: input.manifest.closed_at,
    merchant_name: input.merchant,
    manifest_number: input.manifest.manifest_number || input.manifest.id,
    manifest_date: input.manifest.manifest_date,
    office_id: input.manifest.office_id,
    office_name: input.manifest.office_name,
    shipment_count: input.manifest.shipment_count ?? 0,
    recipient: input.recipient.e164,
    recipient_name: input.recipient.name,
    attachment_filename: indiaPostExcelFilename({
      number: input.manifest.manifest_number,
      date: input.manifest.manifest_date,
      officeId: input.manifest.office_id,
    }),
    status: input.status,
    attempt_count: 0,
    retryable: false,
    last_error: input.lastError ?? null,
    last_error_code: input.lastErrorCode ?? null,
    idempotency_key: input.idempotencyKey,
    batch_id: input.batchId,
    batch_index: input.batchIndex,
    batch_count: input.batchCount,
    file_index: input.fileIndex,
    created_by: input.userId ?? null,
    queued_at: input.status === "QUEUED" ? new Date().toISOString() : null,
  };
}

async function enqueueForRecipients(
  supabase: SupabaseClient,
  organizationId: string,
  manifest: ManifestSource,
  recipients: WhatsAppRecipient[],
  trigger: "AUTO" | "MANUAL",
  userId?: string | null,
  nonce?: string
) {
  const merchant = await merchantName(supabase, organizationId);
  const files = ["xlsx"];
  const batches = chunkFiles(files);
  const batchId = randomUUID();
  const created = [];
  for (const recipient of recipients) {
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex]!;
      for (let offset = 0; offset < batch.length; offset += 1) {
        const fileIndex = batchIndex * MANIFEST_WHATSAPP_MAX_FILES_PER_BATCH + offset;
        const key =
          trigger === "AUTO"
            ? autoIdempotencyKey(organizationId, manifest.id, manifest.closed_at!, recipient.e164, fileIndex)
            : manualIdempotencyKey(organizationId, manifest.id, nonce ?? randomUUID(), recipient.e164, fileIndex);
        let block: { message: string; code: string } | null = null;
        if (!manifestWhatsAppEnabled()) {
          block = { message: "Manifest WhatsApp is turned off on this server.", code: "MANIFEST_WHATSAPP_DISABLED" };
        } else if ((manifest.shipment_count ?? 0) < 1) {
          block = { message: "This manifest has no shipments to send.", code: "MANIFEST_EMPTY" };
        }
        const inserted = await insertDelivery(
          supabase,
          snapshot({
            organizationId,
            manifest,
            merchant,
            recipient,
            trigger,
            idempotencyKey: key,
            batchId,
            batchIndex,
            batchCount: batches.length,
            fileIndex,
            userId,
            status: block ? "FAILED" : "QUEUED",
            lastError: block?.message,
            lastErrorCode: block?.code,
          }),
          userId
        );
        if (inserted.created && !block) {
          try {
            await attachJob(supabase, organizationId, inserted.delivery.id, userId);
          } catch (error) {
            logError("manifest_whatsapp.enqueue_failed", {
              organizationId,
              manifestId: manifest.id,
              message: error instanceof Error ? error.message : "queue failed",
            });
            await writer(supabase)
              .from("manifest_whatsapp_deliveries")
              .update({
                status: "FAILED",
                retryable: true,
                last_error: "The WhatsApp delivery could not be queued. Retry it from the manifest.",
                last_error_code: "QUEUE_UNAVAILABLE",
              })
              .eq("id", inserted.delivery.id)
              .eq("organization_id", organizationId);
          }
        }
        created.push(inserted.delivery);
      }
    }
  }
  return created;
}

export async function enqueueAutoManifestWhatsApp(
  supabase: SupabaseClient,
  organizationId: string,
  manifest: ManifestSource,
  userId?: string | null
) {
  if (manifest.status !== "CLOSED" || !manifest.closed_at) return [];
  const settings = await readManifestWhatsAppSettings(supabase, organizationId);
  if (!settings.autoSendEnabled) return [];
  const resolved = resolveManifestWhatsAppRecipients(settings, manifest.office_id);
  if (!resolved.recipients.length) return [];
  return enqueueForRecipients(supabase, organizationId, manifest, resolved.recipients, "AUTO", userId);
}

export async function listManifestWhatsAppDeliveries(
  supabase: SupabaseClient,
  organizationId: string,
  manifestId: string
) {
  await loadManifest(supabase, organizationId, manifestId);
  const { data, error } = await supabase
    .from("manifest_whatsapp_deliveries")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("manifest_id", manifestId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  return (data ?? []).map((row) => toPublicDelivery(mapDelivery(row)));
}

async function needsResendConfirmation(supabase: SupabaseClient, organizationId: string, manifestId: string) {
  const { data, error } = await supabase
    .from("manifest_whatsapp_deliveries")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("manifest_id", manifestId)
    .in("status", ["ACCEPTED", "SENT", "DELIVERED", "UNKNOWN"])
    .limit(1);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  return Boolean(data?.length);
}

export async function sendManifestWhatsApp(
  supabase: SupabaseClient,
  organizationId: string,
  manifestId: string,
  userId: string | null,
  input: { recipients?: unknown; confirmResend?: boolean }
) {
  if (!manifestWhatsAppEnabled()) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Manifest WhatsApp is turned off on this server.");
  }
  const manifest = await loadManifest(supabase, organizationId, manifestId);
  if (manifest.status !== "CLOSED" && manifest.status !== "HANDED_OVER") {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Close the manifest before sending it on WhatsApp.");
  }
  if (!manifest.closed_at) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "This manifest has no finalization time.");
  }
  if ((manifest.shipment_count ?? 0) < 1) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "This manifest has no shipments to send.");
  }
  const settings = await readManifestWhatsAppSettings(supabase, organizationId);
  const recipients =
    input.recipients === undefined
      ? resolveManifestWhatsAppRecipients(settings, manifest.office_id).recipients
      : normalizeWhatsAppRecipients(input.recipients);
  if (!recipients.length) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Add at least one WhatsApp number.");
  }
  if ((await needsResendConfirmation(supabase, organizationId, manifestId)) && !input.confirmResend) {
    throw new AppError(
      ERROR_CODES.CONFLICT,
      "A previous WhatsApp delivery for this manifest was already accepted or the result was unclear. Confirm to send another copy."
    );
  }
  const rows = await enqueueForRecipients(
    supabase,
    organizationId,
    manifest,
    recipients,
    "MANUAL",
    userId,
    randomUUID()
  );
  return rows.map(toPublicDelivery);
}

export async function retryManifestWhatsApp(
  supabase: SupabaseClient,
  organizationId: string,
  manifestId: string,
  deliveryId: string,
  userId: string | null
) {
  if (!manifestWhatsAppEnabled()) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Manifest WhatsApp is turned off on this server.");
  }
  const db = writer(supabase);
  const { data, error } = await supabase
    .from("manifest_whatsapp_deliveries")
    .select("*")
    .eq("id", deliveryId)
    .eq("organization_id", organizationId)
    .eq("manifest_id", manifestId)
    .maybeSingle();
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  if (!data) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "WhatsApp delivery not found.");
  const delivery = mapDelivery(data);
  if (["ACCEPTED", "SENT", "DELIVERED", "UNKNOWN"].includes(delivery.status)) {
    throw new AppError(
      ERROR_CODES.CONFLICT,
      "This WhatsApp message may already have been accepted. Send the manifest again and confirm that another copy will go out."
    );
  }
  if (delivery.status !== "FAILED" && delivery.status !== "RETRYING") {
    throw new AppError(ERROR_CODES.CONFLICT, "This WhatsApp delivery is already in progress.");
  }
  if (delivery.status === "FAILED" && !delivery.retryable) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      "This WhatsApp delivery cannot be retried. Send the manifest again after the problem is fixed."
    );
  }
  if (delivery.backgroundJobId) {
    const { data: job } = await db
      .from("background_jobs")
      .select("status")
      .eq("id", delivery.backgroundJobId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (job && ACTIVE_JOB.includes(String(job.status))) return toPublicDelivery(delivery);
  }
  const { error: updateError } = await db
    .from("manifest_whatsapp_deliveries")
    .update({
      status: "QUEUED",
      send_phase: null,
      retryable: true,
      attempt_count: 0,
      last_error: null,
      last_error_code: null,
    })
    .eq("id", delivery.id)
    .eq("organization_id", organizationId);
  if (updateError) throw new AppError(ERROR_CODES.VALIDATION_ERROR, updateError.message);
  await attachJob(supabase, organizationId, delivery.id, userId);
  const { data: fresh } = await db
    .from("manifest_whatsapp_deliveries")
    .select("*")
    .eq("id", delivery.id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return toPublicDelivery(mapDelivery(fresh ?? data));
}

export async function probeManifestWhatsApp(supabase: SupabaseClient, organizationId: string) {
  const { data } = await supabase.from("vachat_connections").select("*").eq("organization_id", organizationId).maybeSingle();
  const creds = await resolveVachatSendCredentials(organizationId, data);
  if (!creds) {
    throw new AppError(ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Connect VaChat before testing WhatsApp delivery.");
  }
  await probeVachatMe(creds.apiBaseUrl, creds.apiKey);
  return { connected: true, source: creds.source };
}
