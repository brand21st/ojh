import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { executeManifestEmailDelivery, ManifestEmailRetry } from "@/modules/manifest-email/attempt";
import type { ManifestEmailRepository } from "@/modules/manifest-email/attempt";
import type { EmailDelivery } from "@/modules/manifest-email/types";

function delivery(overrides: Partial<EmailDelivery> = {}): EmailDelivery {
  return {
    id: "delivery-1",
    organizationId: "org-1",
    manifestId: "manifest-1",
    triggerType: "AUTO",
    manifestClosedAt: "2026-11-15T04:30:00.000Z",
    merchantName: "Example Store",
    manifestNumber: "MF-20261115-001",
    manifestDate: "2026-11-15",
    officeId: "22660454",
    officeName: "Kolenchery SO",
    shipmentCount: 2,
    recipients: ["postoffice@example.com"],
    cc: [],
    replyTo: null,
    recipientHash: "hash",
    subject: "India Post Shipment Manifest | Example Store | MF-20261115-001 | 15 Nov 2026",
    templateVersion: "manifest-email-v1",
    filename: "manifest_MF-20261115-001_india_post.xlsx",
    attachmentPath: null,
    attachmentChecksum: null,
    status: "QUEUED",
    smtpPhase: null,
    attemptCount: 0,
    maxAttempts: 5,
    retryable: false,
    lastError: null,
    lastErrorCode: null,
    smtpMessageId: null,
    backgroundJobId: "job-1",
    idempotencyKey: "auto:org-1:manifest-1:2026-11-15T04:30:00.000Z",
    createdAt: "2026-11-15T04:30:00.000Z",
    queuedAt: "2026-11-15T04:30:00.000Z",
    lastAttemptAt: null,
    sentAt: null,
    ...overrides,
  };
}

function memory(initial: EmailDelivery, manifestStatus = "CLOSED", closedAt: string | null = initial.manifestClosedAt) {
  let row = { ...initial };
  const files = new Map<string, Buffer>();
  const repo: ManifestEmailRepository = {
    async get() {
      return { ...row };
    },
    async claim(id) {
      if (row.id !== id) return null;
      if (!["QUEUED", "PENDING", "RETRYING"].includes(row.status) || row.attemptCount >= row.maxAttempts) return null;
      row = {
        ...row,
        status: "SENDING",
        smtpPhase: "CONNECTING",
        attemptCount: row.attemptCount + 1,
        lastAttemptAt: "2026-11-15T04:31:00.000Z",
      };
      return { ...row };
    },
    async resumeConnecting(id, staleBefore) {
      if (row.id !== id || row.status !== "SENDING" || row.smtpPhase !== "CONNECTING") return null;
      if (!row.lastAttemptAt || row.lastAttemptAt >= staleBefore) return null;
      row = { ...row, lastAttemptAt: "2026-11-15T05:00:00.000Z" };
      return { ...row };
    },
    async markUnknown(id, staleBefore, message) {
      if (row.id !== id || row.status !== "SENDING" || row.smtpPhase !== "SUBMITTED") return false;
      if (!row.lastAttemptAt || row.lastAttemptAt >= staleBefore) return false;
      row = { ...row, status: "UNKNOWN", retryable: false, lastError: message, lastErrorCode: "SMTP_UNKNOWN" };
      return true;
    },
    async save(next) {
      row = { ...next };
    },
    async manifest() {
      return { status: manifestStatus, closedAt };
    },
    async loadAttachment(path) {
      return files.get(path) ?? null;
    },
    async storeAttachment(path, bytes) {
      files.set(path, Buffer.from(bytes));
    },
  };
  return { repo, read: () => row, set: (patch: Partial<EmailDelivery>) => { row = { ...row, ...patch }; } };
}

const excel = Buffer.from("excel-bytes");

describe("manifest email delivery", () => {
  it("sends once and keeps the stored file for a later attempt", async () => {
    const state = memory(delivery());
    const send = vi.fn(async () => ({ messageId: "msg-1", response: "250 ok" }));
    const loadExcel = vi.fn(async () => ({ bytes: excel, filename: "ignored.xlsx" }));
    const sent = await executeManifestEmailDelivery(state.repo, "delivery-1", { maxBytes: 1000, send, loadExcel });
    expect(sent?.status).toBe("SENT");
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].filename).toBe("manifest_MF-20261115-001_india_post.xlsx");
    expect(state.read().attachmentChecksum).toBe(createHash("sha256").update(excel).digest("hex"));

    state.set({ status: "RETRYING", smtpPhase: null });
    const secondLoad = vi.fn(async () => ({ bytes: Buffer.from("other"), filename: "nope.xlsx" }));
    const resent = await executeManifestEmailDelivery(state.repo, "delivery-1", {
      maxBytes: 1000,
      send,
      loadExcel: secondLoad,
    });
    expect(resent?.status).toBe("SENT");
    expect(secondLoad).not.toHaveBeenCalled();
  });

  it("retries a refused connection and records a permanent rejection", async () => {
    const retryState = memory(delivery());
    await expect(
      executeManifestEmailDelivery(retryState.repo, "delivery-1", {
        maxBytes: 1000,
        loadExcel: async () => ({ bytes: excel, filename: "x.xlsx" }),
        send: async () => {
          throw Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
        },
      })
    ).rejects.toBeInstanceOf(ManifestEmailRetry);
    expect(retryState.read().status).toBe("RETRYING");

    const denied = memory(delivery());
    const result = await executeManifestEmailDelivery(denied.repo, "delivery-1", {
      maxBytes: 1000,
      loadExcel: async () => ({ bytes: excel, filename: "x.xlsx" }),
      send: async () => {
        throw Object.assign(new Error("user unknown"), { responseCode: 550 });
      },
    });
    expect(result?.status).toBe("FAILED");
    expect(result?.retryable).toBe(false);
  });

  it("does not send an oversized or invalid workbook", async () => {
    const oversized = memory(delivery());
    const send = vi.fn();
    const tooBig = await executeManifestEmailDelivery(oversized.repo, "delivery-1", {
      maxBytes: 4,
      send,
      loadExcel: async () => ({ bytes: excel, filename: "x.xlsx" }),
    });
    expect(tooBig?.status).toBe("FAILED");
    expect(tooBig?.lastErrorCode).toBe("ATTACHMENT_TOO_LARGE");
    expect(send).not.toHaveBeenCalled();

    const invalid = memory(delivery());
    const blocked = await executeManifestEmailDelivery(invalid.repo, "delivery-1", {
      maxBytes: 1000,
      send,
      loadExcel: async () => {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, "One shipment is invalid.");
      },
    });
    expect(blocked?.status).toBe("FAILED");
    expect(blocked?.lastError).toMatch(/invalid/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("cancels a reopened manifest and does not retry an ambiguous send", async () => {
    const reopened = memory(delivery(), "DRAFT", null);
    const send = vi.fn();
    const cancelled = await executeManifestEmailDelivery(reopened.repo, "delivery-1", {
      maxBytes: 1000,
      send,
      loadExcel: vi.fn(),
    });
    expect(cancelled?.status).toBe("CANCELLED");
    expect(send).not.toHaveBeenCalled();

    const ambiguous = memory(
      delivery({
        status: "SENDING",
        smtpPhase: "SUBMITTED",
        attemptCount: 1,
        lastAttemptAt: "2026-11-15T04:00:00.000Z",
      })
    );
    const now = new Date("2026-11-15T04:30:00.000Z");
    const unknown = await executeManifestEmailDelivery(ambiguous.repo, "delivery-1", {
      now,
      maxBytes: 1000,
      send,
      loadExcel: vi.fn(),
    });
    expect(unknown?.status).toBe("UNKNOWN");
    expect(send).not.toHaveBeenCalled();
  });
});
