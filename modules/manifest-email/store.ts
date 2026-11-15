import type { SupabaseClient } from "@supabase/supabase-js";
import { MANIFEST_EMAIL_BUCKET, XLSX_MIME } from "@/modules/manifest-email/config";
import { loadMerchantMailContact } from "@/modules/manifest-email/contact";
import type { EmailDelivery, ManifestEmailGate, SmtpPhase } from "@/modules/manifest-email/types";

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
  recipients: string[] | null;
  cc_recipients: string[] | null;
  reply_to: string | null;
  recipient_hash: string;
  subject: string;
  template_version: string;
  attachment_filename: string;
  attachment_path: string | null;
  attachment_checksum: string | null;
  status: EmailDelivery["status"];
  smtp_phase: SmtpPhase;
  attempt_count: number;
  max_attempts: number;
  retryable: boolean;
  last_error: string | null;
  last_error_code: string | null;
  smtp_message_id: string | null;
  background_job_id: string | null;
  idempotency_key: string;
  created_at: string;
  queued_at: string | null;
  last_attempt_at: string | null;
  sent_at: string | null;
};

function asList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function mapDelivery(row: DeliveryDb): EmailDelivery {
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
    recipients: asList(row.recipients),
    cc: asList(row.cc_recipients),
    replyTo: row.reply_to,
    recipientHash: row.recipient_hash,
    subject: row.subject,
    templateVersion: row.template_version,
    filename: row.attachment_filename,
    attachmentPath: row.attachment_path,
    attachmentChecksum: row.attachment_checksum,
    status: row.status,
    smtpPhase: row.smtp_phase,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    retryable: row.retryable,
    lastError: row.last_error,
    lastErrorCode: row.last_error_code,
    smtpMessageId: row.smtp_message_id,
    backgroundJobId: row.background_job_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    queuedAt: row.queued_at,
    lastAttemptAt: row.last_attempt_at,
    sentAt: row.sent_at,
  };
}

function toDb(row: EmailDelivery) {
  return {
    status: row.status,
    smtp_phase: row.smtpPhase,
    attempt_count: row.attemptCount,
    retryable: row.retryable,
    last_error: row.lastError,
    last_error_code: row.lastErrorCode,
    smtp_message_id: row.smtpMessageId,
    attachment_path: row.attachmentPath,
    attachment_checksum: row.attachmentChecksum,
    sent_at: row.sentAt,
    last_attempt_at: row.lastAttemptAt,
    background_job_id: row.backgroundJobId,
  };
}

export function createDeliveryRepository(supabase: SupabaseClient) {
  return {
    async get(id: string) {
      const { data, error } = await supabase.from("manifest_email_deliveries").select("*").eq("id", id).maybeSingle();
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
        .from("manifest_email_deliveries")
        .update({
          status: "SENDING",
          smtp_phase: "CONNECTING",
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
        .from("manifest_email_deliveries")
        .update({ smtp_phase: "CONNECTING", last_attempt_at: now })
        .eq("id", id)
        .eq("status", "SENDING")
        .eq("smtp_phase", "CONNECTING")
        .lt("last_attempt_at", staleBefore)
        .select("*")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? mapDelivery(data as DeliveryDb) : null;
    },
    async markUnknown(id: string, staleBefore: string, message: string) {
      const { data, error } = await supabase
        .from("manifest_email_deliveries")
        .update({
          status: "UNKNOWN",
          retryable: false,
          last_error: message.slice(0, 300),
          last_error_code: "SMTP_UNKNOWN",
        })
        .eq("id", id)
        .eq("status", "SENDING")
        .eq("smtp_phase", "SUBMITTED")
        .lt("last_attempt_at", staleBefore)
        .select("id")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return Boolean(data);
    },
    async save(row: EmailDelivery) {
      const { error } = await supabase.from("manifest_email_deliveries").update(toDb(row)).eq("id", row.id);
      if (error) throw new Error(error.message);
    },
    async manifest(organizationId: string, manifestId: string): Promise<ManifestEmailGate | null> {
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
      const { data, error } = await supabase.storage.from(MANIFEST_EMAIL_BUCKET).download(path);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer());
    },
    async storeAttachment(path: string, bytes: Buffer) {
      const { error } = await supabase.storage.from(MANIFEST_EMAIL_BUCKET).upload(path, bytes, {
        contentType: XLSX_MIME,
        upsert: true,
      });
      if (error) throw new Error(error.message);
    },
    async merchantContact(organizationId: string) {
      const contact = await loadMerchantMailContact(supabase, organizationId);
      return { email: contact.email, phone: contact.phone };
    },
  };
}
