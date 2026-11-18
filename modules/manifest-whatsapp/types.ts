import type { WhatsAppRecipient } from "@/modules/manifest-whatsapp/recipients";

export const WHATSAPP_DELIVERY_STATUSES = [
  "PENDING",
  "QUEUED",
  "SENDING",
  "ACCEPTED",
  "SENT",
  "DELIVERED",
  "FAILED",
  "RETRYING",
  "CANCELLED",
  "UNKNOWN",
] as const;

export type WhatsAppDeliveryStatus = (typeof WHATSAPP_DELIVERY_STATUSES)[number];
export type DeliveryTrigger = "AUTO" | "MANUAL";
export type SendPhase = "CONNECTING" | "SUBMITTED" | null;

export type WhatsAppDelivery = {
  id: string;
  organizationId: string;
  manifestId: string;
  triggerType: DeliveryTrigger;
  manifestClosedAt: string;
  merchantName: string;
  manifestNumber: string;
  manifestDate: string;
  officeId: string | null;
  officeName: string;
  shipmentCount: number;
  recipient: string;
  recipientName: string | null;
  filename: string;
  attachmentPath: string | null;
  attachmentChecksum: string | null;
  signedUrlExpiresAt: string | null;
  status: WhatsAppDeliveryStatus;
  sendPhase: SendPhase;
  attemptCount: number;
  maxAttempts: number;
  retryable: boolean;
  lastError: string | null;
  lastErrorCode: string | null;
  vachatMessageId: string | null;
  whatsappMessageId: string | null;
  backgroundJobId: string | null;
  batchId: string;
  batchIndex: number;
  batchCount: number;
  fileIndex: number;
  idempotencyKey: string;
  createdAt: string;
  queuedAt: string | null;
  lastAttemptAt: string | null;
  sentAt: string | null;
};

export type ManifestWhatsAppGate = {
  status: string;
  closedAt: string | null;
};

export type PublicWhatsAppDelivery = {
  id: string;
  manifestId: string;
  triggerType: DeliveryTrigger;
  recipient: string;
  recipientName: string | null;
  filename: string;
  status: WhatsAppDeliveryStatus;
  attemptCount: number;
  maxAttempts: number;
  retryable: boolean;
  lastError: string | null;
  batchIndex: number;
  batchCount: number;
  createdAt: string;
  queuedAt: string | null;
  lastAttemptAt: string | null;
  sentAt: string | null;
};

export function toPublicDelivery(row: WhatsAppDelivery): PublicWhatsAppDelivery {
  return {
    id: row.id,
    manifestId: row.manifestId,
    triggerType: row.triggerType,
    recipient: row.recipient,
    recipientName: row.recipientName,
    filename: row.filename,
    status: row.status,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    retryable: row.retryable,
    lastError: row.lastError,
    batchIndex: row.batchIndex,
    batchCount: row.batchCount,
    createdAt: row.createdAt,
    queuedAt: row.queuedAt,
    lastAttemptAt: row.lastAttemptAt,
    sentAt: row.sentAt,
  };
}

export type PublicWhatsAppSettings = {
  autoSendEnabled: boolean;
  recipients: WhatsAppRecipient[];
  officeOverrides: Record<string, WhatsAppRecipient[]>;
  offices: { id: string; name: string }[];
  deliveryEnabled: boolean;
  sessionDocumentsEnabled: boolean;
  templateConfigured: boolean;
  maxRecipients: number;
  maxFilesPerBatch: number;
  lastStatus: WhatsAppDeliveryStatus | null;
  lastSentAt: string | null;
  trigger: "On manifest finalization";
  attachment: "India Post Excel (.xlsx)";
};
