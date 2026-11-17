import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { logError } from "@/lib/logger";
import { hasAdminClient, createAdminClient } from "@/lib/supabase/admin";
import { createBackgroundJob } from "@/modules/jobs/service";
import { manifestEmailEnabled } from "@/modules/manifest-email/config";
import {
  autoIdempotencyKey,
  ccForManifestEmail,
  fillOfficeAddress,
  fillOfficeDisplayName,
  manualIdempotencyKey,
  recipientSetHash,
  resolveManifestRecipients,
  normalizeRecipients,
} from "@/modules/manifest-email/recipients";
import { readManifestEmailSettings } from "@/modules/manifest-email/settings";
import { mapDelivery } from "@/modules/manifest-email/store";
import { loadMerchantMailContact } from "@/modules/manifest-email/contact";
import { MANIFEST_EMAIL_TEMPLATE_VERSION, renderManifestEmail } from "@/modules/manifest-email/template";
import type { EmailDelivery } from "@/modules/manifest-email/types";
import { toPublicDelivery } from "@/modules/manifest-email/types";
import { indiaPostExcelFilename } from "@/modules/manifests/india-post-excel";

type ManifestEmailSource = {
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
  return (await loadMerchantMailContact(supabase, organizationId)).name;
}

const OFFICE_COLUMNS =
  "pickup_dropoff_office_id, pickup_dropoff_office_name, pickup_dropoff_office_pincode, pickup_office_id, pickup_office_name, pickup_office_pincode, pickup_office_city, pickup_office_state";

async function officePresentation(
  supabase: SupabaseClient,
  organizationId: string,
  officeId: string | null,
  storedName: string | null
) {
  const { data } = await supabase
    .from("india_post_connections")
    .select(OFFICE_COLUMNS)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const saved = storedName?.trim();
  return {
    name: saved || fillOfficeDisplayName(officeId, storedName, data) || storedName || "",
    address: fillOfficeAddress(officeId, data),
  };
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
  return data as ManifestEmailSource;
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
    jobType: "manifest-email",
    entityType: "manifest_email_delivery",
    entityId: deliveryId,
    userId: userId ?? undefined,
    progress: { deliveryId },
  });
  await db
    .from("manifest_email_deliveries")
    .update({
      background_job_id: job.id,
      status: "QUEUED",
      queued_at: new Date().toISOString(),
    })
    .eq("id", deliveryId)
    .eq("organization_id", organizationId);
  return job.id as string;
}

async function insertDelivery(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
  userId?: string | null
) {
  const db = writer(supabase);
  const { data, error } = await db.from("manifest_email_deliveries").insert(row).select("*").maybeSingle();
  if (error?.code === "23505") {
    const { data: existing } = await db
      .from("manifest_email_deliveries")
      .select("*")
      .eq("idempotency_key", row.idempotency_key)
      .maybeSingle();
    if (!existing) throw new AppError(ERROR_CODES.CONFLICT, "This manifest email is already queued.");
    const mapped = mapDelivery(existing);
    if (mapped.status === "QUEUED" && !mapped.backgroundJobId) {
      await attachJob(supabase, mapped.organizationId, mapped.id, userId);
    }
    return { delivery: mapped, created: false };
  }
  if (error || !data) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error?.message || "Could not save the email.");
  return { delivery: mapDelivery(data), created: true };
}

function snapshot(input: {
  organizationId: string;
  manifest: ManifestEmailSource;
  merchant: string;
  recipients: string[];
  cc: string[];
  replyTo: string | null;
  trigger: "AUTO" | "MANUAL";
  idempotencyKey: string;
  userId?: string | null;
  status: "QUEUED" | "FAILED";
  lastError?: string;
  lastErrorCode?: string;
  officeAddress: string;
}) {
  const rendered = renderManifestEmail({
    merchantName: input.merchant,
    manifestNumber: input.manifest.manifest_number || input.manifest.id,
    manifestDate: input.manifest.manifest_date,
    shipmentCount: input.manifest.shipment_count ?? 0,
    officeName: input.manifest.office_name || "",
    officeAddress: input.officeAddress,
  });
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
    recipients: input.recipients,
    cc_recipients: input.cc,
    reply_to: input.replyTo,
    recipient_hash: recipientSetHash({ recipients: input.recipients, cc: input.cc, replyTo: input.replyTo }),
    subject: rendered.subject,
    template_version: MANIFEST_EMAIL_TEMPLATE_VERSION,
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
    created_by: input.userId ?? null,
    queued_at: input.status === "QUEUED" ? new Date().toISOString() : null,
  };
}

export async function enqueueAutoManifestEmail(
  supabase: SupabaseClient,
  organizationId: string,
  manifest: ManifestEmailSource,
  userId?: string | null
) {
  if (manifest.status !== "CLOSED" || !manifest.closed_at) return null;
  const settings = await readManifestEmailSettings(supabase, organizationId);
  if (!settings.autoSendEnabled) return null;
  const resolved = resolveManifestRecipients(settings, manifest.office_id);
  const merchant = await merchantName(supabase, organizationId);
  const office = await officePresentation(supabase, organizationId, manifest.office_id, manifest.office_name);
  const key = autoIdempotencyKey(organizationId, manifest.id, manifest.closed_at);
  let block: { message: string; code: string } | null = null;
  if (!manifestEmailEnabled()) {
    block = { message: "Manifest email is turned off on this server.", code: "MANIFEST_EMAIL_DISABLED" };
  } else if (!resolved.recipients.length) {
    block = {
      message: "No India Post email recipients are saved for this booking office.",
      code: "RECIPIENTS_MISSING",
    };
  } else if ((manifest.shipment_count ?? 0) < 1) {
    block = { message: "This manifest has no shipments to email.", code: "MANIFEST_EMPTY" };
  }
  const inserted = await insertDelivery(
    supabase,
    snapshot({
      organizationId,
      manifest: { ...manifest, office_name: office.name || manifest.office_name },
      merchant,
      recipients: resolved.recipients,
      cc: ccForManifestEmail(settings, manifest.office_id),
      replyTo: settings.replyTo,
      trigger: "AUTO",
      idempotencyKey: key,
      userId,
      status: block ? "FAILED" : "QUEUED",
      lastError: block?.message,
      lastErrorCode: block?.code,
      officeAddress: office.address,
    }),
    userId
  );
  if (!inserted.created || block) return inserted.delivery;
  try {
    await attachJob(supabase, organizationId, inserted.delivery.id, userId);
  } catch (error) {
    logError("manifest_email.enqueue_failed", {
      organizationId,
      manifestId: manifest.id,
      message: error instanceof Error ? error.message : "queue failed",
    });
    await writer(supabase)
      .from("manifest_email_deliveries")
      .update({
        status: "FAILED",
        retryable: true,
        last_error: "The email could not be queued. Retry it from the manifest.",
        last_error_code: "QUEUE_UNAVAILABLE",
      })
      .eq("id", inserted.delivery.id)
      .eq("organization_id", organizationId);
  }
  return inserted.delivery;
}

export async function listManifestEmailDeliveries(supabase: SupabaseClient, organizationId: string, manifestId: string) {
  await loadManifest(supabase, organizationId, manifestId);
  const { data, error } = await supabase
    .from("manifest_email_deliveries")
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
    .from("manifest_email_deliveries")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("manifest_id", manifestId)
    .in("status", ["SENT", "UNKNOWN"])
    .limit(1);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  return Boolean(data?.length);
}

export async function sendManifestEmail(
  supabase: SupabaseClient,
  organizationId: string,
  manifestId: string,
  userId: string | null,
  input: { recipients?: unknown; confirmResend?: boolean }
) {
  if (!manifestEmailEnabled()) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Manifest email is turned off on this server.");
  }
  const manifest = await loadManifest(supabase, organizationId, manifestId);
  if (manifest.status !== "CLOSED" && manifest.status !== "HANDED_OVER") {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Close the manifest before emailing it.");
  }
  if (!manifest.closed_at) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "This manifest has no finalization time.");
  }
  if ((manifest.shipment_count ?? 0) < 1) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "This manifest has no shipments to email.");
  }
  const settings = await readManifestEmailSettings(supabase, organizationId);
  const recipients = input.recipients === undefined
    ? resolveManifestRecipients(settings, manifest.office_id).recipients
    : normalizeRecipients(input.recipients);
  if (!recipients.length) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Add at least one email address.");
  }
  if ((await needsResendConfirmation(supabase, organizationId, manifestId)) && !input.confirmResend) {
    throw new AppError(
      ERROR_CODES.CONFLICT,
      "A previous email for this manifest was already accepted or the result was unclear. Confirm to send another copy."
    );
  }
  const merchant = await merchantName(supabase, organizationId);
  const office = await officePresentation(supabase, organizationId, manifest.office_id, manifest.office_name);
  const inserted = await insertDelivery(
    supabase,
    snapshot({
      organizationId,
      manifest: { ...manifest, office_name: office.name || manifest.office_name },
      merchant,
      recipients,
      cc: ccForManifestEmail(settings, manifest.office_id),
      replyTo: settings.replyTo,
      trigger: "MANUAL",
      idempotencyKey: manualIdempotencyKey(organizationId, manifestId, randomUUID()),
      userId,
      status: "QUEUED",
      officeAddress: office.address,
    }),
    userId
  );
  await attachJob(supabase, organizationId, inserted.delivery.id, userId);
  const { data } = await writer(supabase)
    .from("manifest_email_deliveries")
    .select("*")
    .eq("id", inserted.delivery.id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return toPublicDelivery(mapDelivery(data ?? inserted.delivery));
}

export async function retryManifestEmail(
  supabase: SupabaseClient,
  organizationId: string,
  manifestId: string,
  deliveryId: string,
  userId: string | null
) {
  if (!manifestEmailEnabled()) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Manifest email is turned off on this server.");
  }
  const db = writer(supabase);
  const { data, error } = await supabase
    .from("manifest_email_deliveries")
    .select("*")
    .eq("id", deliveryId)
    .eq("organization_id", organizationId)
    .eq("manifest_id", manifestId)
    .maybeSingle();
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  if (!data) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, "Email delivery not found.");
  const delivery = mapDelivery(data) as EmailDelivery;
  if (delivery.status === "SENT" || delivery.status === "UNKNOWN") {
    throw new AppError(
      ERROR_CODES.CONFLICT,
      "This email may already have been accepted. Send the manifest again and confirm that another copy will go out."
    );
  }
  if (delivery.status !== "FAILED" && delivery.status !== "RETRYING") {
    throw new AppError(ERROR_CODES.CONFLICT, "This email is already in progress.");
  }
  if (delivery.status === "FAILED" && !delivery.retryable) {
    throw new AppError(
      ERROR_CODES.VALIDATION_ERROR,
      "This email cannot be retried. Send the manifest again after the problem is fixed."
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
    .from("manifest_email_deliveries")
    .update({
      status: "QUEUED",
      smtp_phase: null,
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
    .from("manifest_email_deliveries")
    .select("*")
    .eq("id", delivery.id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return toPublicDelivery(mapDelivery(fresh ?? data));
}
