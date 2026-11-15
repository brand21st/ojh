import { createHash } from "node:crypto";
import { AppError } from "@/lib/api/errors";
import { MANIFEST_EMAIL_STALE_MS } from "@/modules/manifest-email/config";
import type { MailAccepted, OutboundManifestMail, SmtpTransport } from "@/modules/manifest-email/smtp";
import { classifySmtpFailure } from "@/modules/manifest-email/smtp";
import { renderManifestEmail } from "@/modules/manifest-email/template";
import type { EmailDelivery, ManifestEmailGate } from "@/modules/manifest-email/types";

export type ExcelFile = { bytes: Buffer; filename: string };

export type ManifestEmailRepository = {
  get(id: string): Promise<EmailDelivery | null>;
  claim(id: string): Promise<EmailDelivery | null>;
  resumeConnecting(id: string, staleBefore: string): Promise<EmailDelivery | null>;
  markUnknown(id: string, staleBefore: string, message: string): Promise<boolean>;
  save(row: EmailDelivery): Promise<void>;
  manifest(organizationId: string, manifestId: string): Promise<ManifestEmailGate | null>;
  loadAttachment(path: string): Promise<Buffer | null>;
  storeAttachment(path: string, bytes: Buffer): Promise<void>;
  merchantContact(organizationId: string): Promise<{ email: string; phone: string }>;
};

export type ManifestEmailDeps = {
  now?: Date;
  staleMs?: number;
  maxBytes: number;
  send: (mail: OutboundManifestMail, transport?: SmtpTransport) => Promise<MailAccepted>;
  loadExcel: (organizationId: string, manifestId: string) => Promise<ExcelFile>;
};

const TERMINAL = new Set(["SENT", "CANCELLED", "UNKNOWN"]);

export class ManifestEmailRetry extends Error {
  code = "SMTP_TEMPORARY";
  constructor(message: string) {
    super(message);
    this.name = "ManifestEmailRetry";
  }
}

function staleBefore(now: Date, staleMs: number) {
  return new Date(now.getTime() - staleMs).toISOString();
}

function checksum(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function failed(row: EmailDelivery, message: string, code: string, retryable = false): EmailDelivery {
  return {
    ...row,
    status: "FAILED",
    smtpPhase: null,
    retryable,
    lastError: message.slice(0, 300),
    lastErrorCode: code,
  };
}

export async function executeManifestEmailDelivery(
  repo: ManifestEmailRepository,
  deliveryId: string,
  deps: ManifestEmailDeps
) {
  const now = deps.now ?? new Date();
  const cutoff = staleBefore(now, deps.staleMs ?? MANIFEST_EMAIL_STALE_MS);
  let row = await repo.claim(deliveryId);
  if (!row) {
    const current = await repo.get(deliveryId);
    if (!current || TERMINAL.has(current.status) || current.status === "FAILED") return current;
    if (current.status === "SENDING" && current.smtpPhase === "SUBMITTED") {
      await repo.markUnknown(
        deliveryId,
        cutoff,
        "The mail server may have accepted the message, but the result was not saved. Send again only if the office did not receive it."
      );
      return repo.get(deliveryId);
    }
    if (current.status === "SENDING" && current.smtpPhase === "CONNECTING") {
      row = await repo.resumeConnecting(deliveryId, cutoff);
    }
    if (!row) return current;
  }

  const manifest = await repo.manifest(row.organizationId, row.manifestId);
  if (!manifest || (manifest.status !== "CLOSED" && manifest.status !== "HANDED_OVER") || manifest.closedAt !== row.manifestClosedAt) {
    const cancelled: EmailDelivery = {
      ...row,
      status: "CANCELLED",
      smtpPhase: null,
      retryable: false,
      lastError: "This manifest was reopened or changed before the email was sent.",
      lastErrorCode: "MANIFEST_NOT_FINAL",
    };
    await repo.save(cancelled);
    return cancelled;
  }

  let bytes: Buffer | null = null;
  if (row.attachmentPath && row.attachmentChecksum) {
    bytes = await repo.loadAttachment(row.attachmentPath);
    if (!bytes || checksum(bytes) !== row.attachmentChecksum) {
      const broken = failed(row, "The saved Excel file could not be read again. Send the manifest again.", "ATTACHMENT_MISSING");
      await repo.save(broken);
      return broken;
    }
  } else {
    try {
      const file = await deps.loadExcel(row.organizationId, row.manifestId);
      bytes = file.bytes;
    } catch (error) {
      const message = error instanceof Error ? error.message : "This manifest cannot be exported.";
      const broken = failed(row, message, error instanceof AppError ? error.code : "VALIDATION_ERROR");
      await repo.save(broken);
      return broken;
    }
    if (bytes.byteLength > deps.maxBytes) {
      const sizeMb = (bytes.byteLength / (1024 * 1024)).toFixed(1);
      const limitMb = (deps.maxBytes / (1024 * 1024)).toFixed(0);
      const broken = failed(
        row,
        `The Excel file is ${sizeMb} MB. The mail server limit is ${limitMb} MB. Download the Excel from the manifest and send it another way.`,
        "ATTACHMENT_TOO_LARGE"
      );
      await repo.save(broken);
      return broken;
    }
    const path = `${row.organizationId}/${row.id}.xlsx`;
    await repo.storeAttachment(path, bytes);
    row = { ...row, attachmentPath: path, attachmentChecksum: checksum(bytes) };
    await repo.save(row);
  }

  if (!row.recipients.length) {
    const empty = failed(row, "No email recipients are saved for this manifest.", "RECIPIENTS_MISSING");
    await repo.save(empty);
    return empty;
  }

  const contact = await repo.merchantContact(row.organizationId);
  const rendered = renderManifestEmail({
    merchantName: row.merchantName,
    merchantEmail: contact.email || row.replyTo || "",
    merchantPhone: contact.phone,
    manifestNumber: row.manifestNumber,
    manifestDate: row.manifestDate,
    shipmentCount: row.shipmentCount,
    officeName: row.officeName,
  });
  row = { ...row, smtpPhase: "SUBMITTED" };
  await repo.save(row);

  try {
    const accepted = await deps.send({
      to: row.recipients,
      cc: row.cc,
      replyTo: row.replyTo,
      subject: row.subject,
      text: rendered.text,
      html: rendered.html,
      filename: row.filename,
      content: bytes,
    });
    const sent: EmailDelivery = {
      ...row,
      status: "SENT",
      smtpPhase: null,
      retryable: false,
      lastError: null,
      lastErrorCode: null,
      smtpMessageId: accepted.messageId || null,
      sentAt: now.toISOString(),
    };
    await repo.save(sent);
    return sent;
  } catch (error) {
    const failure = classifySmtpFailure(error, "SUBMITTED");
    if (failure.kind === "unknown") {
      const unknown: EmailDelivery = {
        ...row,
        status: "UNKNOWN",
        smtpPhase: "SUBMITTED",
        retryable: false,
        lastError: failure.message,
        lastErrorCode: failure.code,
      };
      await repo.save(unknown);
      return unknown;
    }
    if (failure.kind === "permanent") {
      const done = failed(row, failure.message, failure.code, false);
      await repo.save(done);
      return done;
    }
    if (row.attemptCount >= row.maxAttempts) {
      const done = failed(row, failure.message, failure.code, true);
      await repo.save(done);
      return done;
    }
    const retrying: EmailDelivery = {
      ...row,
      status: "RETRYING",
      smtpPhase: null,
      retryable: true,
      lastError: failure.message,
      lastErrorCode: failure.code,
    };
    await repo.save(retrying);
    throw new ManifestEmailRetry("The mail server is temporarily unavailable.");
  }
}
