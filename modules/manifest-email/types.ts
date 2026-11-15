export const DELIVERY_STATUSES = [
  "PENDING",
  "QUEUED",
  "SENDING",
  "SENT",
  "FAILED",
  "RETRYING",
  "CANCELLED",
  "UNKNOWN",
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type DeliveryTrigger = "AUTO" | "MANUAL";
export type SmtpPhase = "CONNECTING" | "SUBMITTED" | null;

export type EmailDelivery = {
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
  recipients: string[];
  cc: string[];
  replyTo: string | null;
  recipientHash: string;
  subject: string;
  templateVersion: string;
  filename: string;
  attachmentPath: string | null;
  attachmentChecksum: string | null;
  status: DeliveryStatus;
  smtpPhase: SmtpPhase;
  attemptCount: number;
  maxAttempts: number;
  retryable: boolean;
  lastError: string | null;
  lastErrorCode: string | null;
  smtpMessageId: string | null;
  backgroundJobId: string | null;
  idempotencyKey: string;
  createdAt: string;
  queuedAt: string | null;
  lastAttemptAt: string | null;
  sentAt: string | null;
};

export type ManifestEmailGate = {
  status: string;
  closedAt: string | null;
};

export type DeliveryPatch = Partial<EmailDelivery> & { id: string };

export type PublicEmailDelivery = {
  id: string;
  manifestId: string;
  triggerType: DeliveryTrigger;
  recipients: string[];
  cc: string[];
  replyTo: string | null;
  subject: string;
  filename: string;
  status: DeliveryStatus;
  attemptCount: number;
  maxAttempts: number;
  retryable: boolean;
  lastError: string | null;
  createdAt: string;
  queuedAt: string | null;
  lastAttemptAt: string | null;
  sentAt: string | null;
};

export function toPublicDelivery(row: EmailDelivery): PublicEmailDelivery {
  return {
    id: row.id,
    manifestId: row.manifestId,
    triggerType: row.triggerType,
    recipients: row.recipients,
    cc: row.cc,
    replyTo: row.replyTo,
    subject: row.subject,
    filename: row.filename,
    status: row.status,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    retryable: row.retryable,
    lastError: row.lastError,
    createdAt: row.createdAt,
    queuedAt: row.queuedAt,
    lastAttemptAt: row.lastAttemptAt,
    sentAt: row.sentAt,
  };
}
