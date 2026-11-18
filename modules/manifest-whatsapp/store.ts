import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MANIFEST_WHATSAPP_BUCKET,
  XLSX_MIME,
  manifestWhatsAppSignedTtlSeconds,
} from "@/modules/manifest-whatsapp/config";
import type { SendPhase, WhatsAppDelivery, ManifestWhatsAppGate } from "@/modules/manifest-whatsapp/types";

type DeliveryDb = {
  id: string;
  organization_id: string;
  manifest_id: string;
  trigger_type: "AUTO" | "MANUAL";
  manifest_closed_at: string;
  merchant_name: string;
  manifest_number: string;
  manifest_date: string;
  office_id: string | null;
  office_name: string | null;
  shipment_count: number;
  recipient: string;
  recipient_name: string | null;
  attachment_filename: string;
  attachment_path: string | null;
  attachment_checksum: string | null;
  signed_url_expires_at: string | null;
  status: WhatsAppDelivery["status"];
  send_phase: SendPhase;
  attempt_count: number;
  max_attempts: number;
  retryable: boolean;
  last_error: string | null;
  last_error_code: string | null;
  vachat_message_id: string | null;
  whatsapp_message_id: string | null;
  background_job_id: string | null;
  batch_id: string;
  batch_index: number;
  batch_count: number;
  file_index: number;
  idempotency_key: string;
  created_at: string;
  queued_at: string | null;
  last_attempt_at: string | null;
  sent_at: string | null;
};

export function mapDelivery(row: DeliveryDb): WhatsAppDelivery {
  return {
    id: row.id,
    organizationId: row.organization_id,
    manifestId: row.manifest_id,
    triggerType: row.trigger_type,
    manifestClosedAt: row.manifest_closed_at,
    merchantName: row.merchant_name,
    manifestNumber: row.manifest_number,
    manifestDate: row.manifest_date,
    officeId: row.office_id,
    officeName: row.office_name || "",
    shipmentCount: row.shipment_count,
    recipient: row.recipient,
    recipientName: row.recipient_name,
    filename: row.attachment_filename,
    attachmentPath: row.attachment_path,
    attachmentChecksum: row.attachment_checksum,
    signedUrlExpiresAt: row.signed_url_expires_at,
    status: row.status,
    sendPhase: row.send_phase,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    retryable: row.retryable,
    lastError: row.last_error,
    lastErrorCode: row.last_error_code,
    vachatMessageId: row.vachat_message_id,
    whatsappMessageId: row.whatsapp_message_id,
    backgroundJobId: row.background_job_id,
    batchId: row.batch_id,
    batchIndex: row.batch_index,
    batchCount: row.batch_count,
    fileIndex: row.file_index,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    queuedAt: row.queued_at,
    lastAttemptAt: row.last_attempt_at,
    sentAt: row.sent_at,
  };
}

function toDb(row: WhatsAppDelivery) {
  return {
    status: row.status,
    send_phase: row.sendPhase,
    attempt_count: row.attemptCount,
    retryable: row.retryable,
    last_error: row.lastError,
    last_error_code: row.lastErrorCode,
    vachat_message_id: row.vachatMessageId,
    whatsapp_message_id: row.whatsappMessageId,
    attachment_path: row.attachmentPath,
    attachment_checksum: row.attachmentChecksum,
    signed_url_expires_at: row.signedUrlExpiresAt,
    sent_at: row.sentAt,
    last_attempt_at: row.lastAttemptAt,
    background_job_id: row.backgroundJobId,
  };
}

export function createWhatsAppDeliveryRepository(supabase: SupabaseClient) {
  return {
    async get(id: string) {
      const { data, error } = await supabase.from("manifest_whatsapp_deliveries").select("*").eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? mapDelivery(data as DeliveryDb) : null;
    },
    async claim(id: string) {
      const current = await this.get(id);
      if (!current) return null;
      if (!["QUEUED", "PENDING", "RETRYING"].includes(current.status)) return null;
      if (current.attemptCount >= current.maxAttempts) return null;
      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from("manifest_whatsapp_deliveries")
        .update({
          status: "SENDING",
          send_phase: "CONNECTING",
          attempt_count: current.attemptCount + 1,
          last_attempt_at: now,
        })
        .eq("id", id)
        .eq("status", current.status)
        .eq("attempt_count", current.attemptCount)
        .select("*")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? mapDelivery(data as DeliveryDb) : null;
    },
    async resumeConnecting(id: string, staleBefore: string) {
      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from("manifest_whatsapp_deliveries")
        .update({ send_phase: "CONNECTING", last_attempt_at: now })
        .eq("id", id)
        .eq("status", "SENDING")
        .eq("send_phase", "CONNECTING")
        .lt("last_attempt_at", staleBefore)
        .select("*")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? mapDelivery(data as DeliveryDb) : null;
    },
    async markUnknown(id: string, staleBefore: string, message: string) {
      const { data, error } = await supabase
        .from("manifest_whatsapp_deliveries")
        .update({
          status: "UNKNOWN",
          retryable: false,
          last_error: message.slice(0, 300),
          last_error_code: "VACHAT_UNKNOWN",
        })
        .eq("id", id)
        .eq("status", "SENDING")
        .eq("send_phase", "SUBMITTED")
        .lt("last_attempt_at", staleBefore)
        .select("id")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return Boolean(data);
    },
    async save(row: WhatsAppDelivery) {
      const { error } = await supabase.from("manifest_whatsapp_deliveries").update(toDb(row)).eq("id", row.id);
      if (error) throw new Error(error.message);
    },
    async manifest(organizationId: string, manifestId: string): Promise<ManifestWhatsAppGate | null> {
      const { data, error } = await supabase
        .from("manifests")
        .select("status, closed_at")
        .eq("organization_id", organizationId)
        .eq("id", manifestId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      return { status: String(data.status), closedAt: (data.closed_at as string | null) ?? null };
    },
    async loadAttachment(path: string) {
      const { data, error } = await supabase.storage.from(MANIFEST_WHATSAPP_BUCKET).download(path);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer());
    },
    async storeAttachment(path: string, bytes: Buffer) {
      const { error } = await supabase.storage.from(MANIFEST_WHATSAPP_BUCKET).upload(path, bytes, {
        contentType: XLSX_MIME,
        upsert: true,
      });
      if (error) throw new Error(error.message);
    },
    async signAttachment(path: string) {
      const ttl = manifestWhatsAppSignedTtlSeconds();
      const { data, error } = await supabase.storage.from(MANIFEST_WHATSAPP_BUCKET).createSignedUrl(path, ttl);
      if (error || !data?.signedUrl) throw new Error(error?.message || "Could not create a download link.");
      return {
        url: data.signedUrl,
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      };
    },
  };
}
