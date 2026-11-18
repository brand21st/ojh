import { createHash } from "node:crypto";
import { AppError } from "@/lib/api/errors";
import { classifyProviderError } from "@/lib/jobs/retry";
import { isPermanentVachatNotifyFailure } from "@/modules/vachat/logs";
import {
  MANIFEST_WHATSAPP_STALE_MS,
  manifestWhatsAppSessionDocumentsEnabled,
  manifestWhatsAppTemplateLanguage,
  manifestWhatsAppTemplateName,
} from "@/modules/manifest-whatsapp/config";
import { chooseManifestWhatsAppSendMode } from "@/modules/manifest-whatsapp/strategy";
import type { ManifestWhatsAppGate, WhatsAppDelivery } from "@/modules/manifest-whatsapp/types";
import { sanitizeWhatsAppError } from "@/modules/manifest-whatsapp/urls";
import type { ManifestWhatsAppSendInput, ManifestWhatsAppSendResult } from "@/modules/manifest-whatsapp/send";

export type ExcelFile = { bytes: Buffer; filename: string };

export type ManifestWhatsAppRepository = {
  get(id: string): Promise<WhatsAppDelivery | null>;
  claim(id: string): Promise<WhatsAppDelivery | null>;
  resumeConnecting(id: string, staleBefore: string): Promise<WhatsAppDelivery | null>;
  markUnknown(id: string, staleBefore: string, message: string): Promise<boolean>;
  save(row: WhatsAppDelivery): Promise<void>;
  manifest(organizationId: string, manifestId: string): Promise<ManifestWhatsAppGate | null>;
  loadAttachment(path: string): Promise<Buffer | null>;
  storeAttachment(path: string, bytes: Buffer): Promise<void>;
  signAttachment(path: string): Promise<{ url: string; expiresAt: string }>;
};

export type ManifestWhatsAppDeps = {
  now?: Date;
  staleMs?: number;
  maxBytes: number;
  send: (input: ManifestWhatsAppSendInput) => Promise<ManifestWhatsAppSendResult>;
  loadExcel: (organizationId: string, manifestId: string) => Promise<ExcelFile>;
  credentials: (organizationId: string) => Promise<{ apiKey: string; apiBaseUrl: string } | null>;
  sendMode?: ReturnType<typeof chooseManifestWhatsAppSendMode>;
};

const TERMINAL = new Set(["ACCEPTED", "SENT", "DELIVERED", "CANCELLED", "UNKNOWN"]);

export class ManifestWhatsAppRetry extends Error {
  code = "VACHAT_TEMPORARY";
  constructor(message: string) {
    super(message);
    this.name = "ManifestWhatsAppRetry";
  }
}

function staleBefore(now: Date, staleMs: number) {
  return new Date(now.getTime() - staleMs).toISOString();
}

function checksum(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function failed(row: WhatsAppDelivery, message: string, code: string, retryable = false): WhatsAppDelivery {
  return {
    ...row,
    status: "FAILED",
    sendPhase: null,
    retryable,
    lastError: message.slice(0, 300),
    lastErrorCode: code,
  };
}

export async function executeManifestWhatsAppDelivery(
  repo: ManifestWhatsAppRepository,
  deliveryId: string,
  deps: ManifestWhatsAppDeps
) {
  const now = deps.now ?? new Date();
  const cutoff = staleBefore(now, deps.staleMs ?? MANIFEST_WHATSAPP_STALE_MS);
  let row = await repo.claim(deliveryId);
  if (!row) {
    const current = await repo.get(deliveryId);
    if (!current || TERMINAL.has(current.status) || current.status === "FAILED") return current;
    if (current.status === "SENDING" && current.sendPhase === "SUBMITTED") {
      await repo.markUnknown(
        deliveryId,
        cutoff,
        "Vachat may have accepted the WhatsApp message, but the result was not saved. Send again only if the office did not receive it."
      );
      return repo.get(deliveryId);
    }
    if (current.status === "SENDING" && current.sendPhase === "CONNECTING") {
      row = await repo.resumeConnecting(deliveryId, cutoff);
    }
    if (!row) return current;
  }

  const manifest = await repo.manifest(row.organizationId, row.manifestId);
  if (!manifest || (manifest.status !== "CLOSED" && manifest.status !== "HANDED_OVER") || manifest.closedAt !== row.manifestClosedAt) {
    const cancelled: WhatsAppDelivery = {
      ...row,
      status: "CANCELLED",
      sendPhase: null,
      retryable: false,
      lastError: "This manifest was reopened or changed before WhatsApp delivery finished.",
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
        `The Excel file is ${sizeMb} MB. The WhatsApp limit is ${limitMb} MB.`,
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

  const mode =
    deps.sendMode ??
    chooseManifestWhatsAppSendMode({
      sessionDocumentsEnabled: manifestWhatsAppSessionDocumentsEnabled(),
      templateName: manifestWhatsAppTemplateName(),
      windowOpen: null,
    });
  if (mode.mode === "blocked") {
    const blocked = failed(
      row,
      "WhatsApp document delivery needs an approved utility template, or an authorized session-document test flag. Direct Excel messages are not sent when the 24-hour window cannot be confirmed.",
      "TEMPLATE_REQUIRED"
    );
    await repo.save(blocked);
    return blocked;
  }

  const creds = await deps.credentials(row.organizationId);
  if (!creds) {
    const blocked = failed(row, "Connect VaChat before sending a manifest on WhatsApp.", "INTEGRATION_NOT_CONNECTED");
    await repo.save(blocked);
    return blocked;
  }

  let signed: { url: string; expiresAt: string };
  try {
    signed = await repo.signAttachment(row.attachmentPath!);
  } catch (error) {
    const broken = failed(row, sanitizeWhatsAppError(error), "SIGNED_URL_FAILED", true);
    await repo.save(broken);
    throw new ManifestWhatsAppRetry("Could not create a download link for WhatsApp.");
  }
  row = { ...row, signedUrlExpiresAt: signed.expiresAt, sendPhase: "SUBMITTED" };
  await repo.save(row);

  try {
    const accepted = await deps.send({
      apiBaseUrl: creds.apiBaseUrl,
      apiKey: creds.apiKey,
      to: row.recipient,
      filename: row.filename,
      caption: `India Post booking manifest ${row.manifestNumber}`,
      mediaUrl: signed.url,
      mode: mode.mode,
      templateName: mode.mode === "template_link" ? mode.templateName : undefined,
      templateLanguage: manifestWhatsAppTemplateLanguage(),
      bodyParams: [row.merchantName, row.manifestNumber, row.manifestDate],
    });
    const sent: WhatsAppDelivery = {
      ...row,
      status: "ACCEPTED",
      sendPhase: null,
      retryable: false,
      lastError: null,
      lastErrorCode: null,
      vachatMessageId: accepted.messageId,
      whatsappMessageId: accepted.whatsappMessageId,
      sentAt: now.toISOString(),
    };
    await repo.save(sent);
    return sent;
  } catch (error) {
    const anyError = error as { status?: number; code?: string };
    const classified = classifyProviderError(error);
    if (isPermanentVachatNotifyFailure(anyError.code, anyError.status) || !classified.retryable) {
      const done = failed(row, sanitizeWhatsAppError(error), classified.code, false);
      await repo.save(done);
      return done;
    }
    if (anyError.status === 429 || classified.code === "HTTP_429") {
      if (row.attemptCount >= row.maxAttempts) {
        const done = failed(row, sanitizeWhatsAppError(error), "HTTP_429", true);
        await repo.save(done);
        return done;
      }
      const retrying: WhatsAppDelivery = {
        ...row,
        status: "RETRYING",
        sendPhase: null,
        retryable: true,
        lastError: sanitizeWhatsAppError(error),
        lastErrorCode: "HTTP_429",
      };
      await repo.save(retrying);
      throw new ManifestWhatsAppRetry("VaChat rate-limited the WhatsApp send.");
    }
    const unknown: WhatsAppDelivery = {
      ...row,
      status: "UNKNOWN",
      sendPhase: "SUBMITTED",
      retryable: false,
      lastError: "VaChat may have accepted the WhatsApp message, but the result was not confirmed. Send again only if the office did not receive it.",
      lastErrorCode: "VACHAT_UNKNOWN",
    };
    await repo.save(unknown);
    return unknown;
  }
}
