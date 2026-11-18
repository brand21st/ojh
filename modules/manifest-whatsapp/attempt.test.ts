import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { executeManifestWhatsAppDelivery, ManifestWhatsAppRetry } from "@/modules/manifest-whatsapp/attempt";
import type { ManifestWhatsAppRepository } from "@/modules/manifest-whatsapp/attempt";
import type { WhatsAppDelivery } from "@/modules/manifest-whatsapp/types";

function delivery(overrides: Partial<WhatsAppDelivery> = {}): WhatsAppDelivery {
  return {
    id: "delivery-1",
    organizationId: "org-1",
    manifestId: "manifest-1",
    triggerType: "AUTO",
    manifestClosedAt: "2026-11-17T04:30:00.000Z",
    merchantName: "Example Store",
    manifestNumber: "MF-20261117-001",
    manifestDate: "2026-11-17",
    officeId: "22660454",
    officeName: "Kolenchery SO",
    shipmentCount: 2,
    recipient: "+919876543210",
    recipientName: "Office",
    filename: "manifest_MF-20261117-001_india_post.xlsx",
    attachmentPath: null,
    attachmentChecksum: null,
    signedUrlExpiresAt: null,
    status: "QUEUED",
    sendPhase: null,
    attemptCount: 0,
    maxAttempts: 5,
    retryable: false,
    lastError: null,
    lastErrorCode: null,
    vachatMessageId: null,
    whatsappMessageId: null,
    backgroundJobId: "job-1",
    batchId: "batch-1",
    batchIndex: 0,
    batchCount: 1,
    fileIndex: 0,
    idempotencyKey: "auto:org-1:manifest-1:2026-11-17T04:30:00.000Z:+919876543210:0",
    createdAt: "2026-11-17T04:30:00.000Z",
    queuedAt: "2026-11-17T04:30:00.000Z",
    lastAttemptAt: null,
    sentAt: null,
    ...overrides,
  };
}

function memory(initial: WhatsAppDelivery, manifestStatus = "CLOSED", closedAt: string | null = initial.manifestClosedAt) {
  let row = { ...initial };
  const files = new Map<string, Buffer>();
  const repo: ManifestWhatsAppRepository = {
    async get() {
      return { ...row };
    },
    async claim(id) {
      if (row.id !== id) return null;
      if (!["QUEUED", "PENDING", "RETRYING"].includes(row.status) || row.attemptCount >= row.maxAttempts) return null;
      row = {
        ...row,
        status: "SENDING",
        sendPhase: "CONNECTING",
        attemptCount: row.attemptCount + 1,
        lastAttemptAt: "2026-11-17T04:31:00.000Z",
      };
      return { ...row };
    },
    async resumeConnecting(id, staleBefore) {
      if (row.id !== id || row.status !== "SENDING" || row.sendPhase !== "CONNECTING") return null;
      if (!row.lastAttemptAt || row.lastAttemptAt >= staleBefore) return null;
      row = { ...row, lastAttemptAt: "2026-11-17T05:00:00.000Z" };
      return { ...row };
    },
    async markUnknown(id, staleBefore, message) {
      if (row.id !== id || row.status !== "SENDING" || row.sendPhase !== "SUBMITTED") return false;
      if (!row.lastAttemptAt || row.lastAttemptAt >= staleBefore) return false;
      row = { ...row, status: "UNKNOWN", retryable: false, lastError: message, lastErrorCode: "VACHAT_UNKNOWN" };
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
    async signAttachment(path) {
      return { url: `https://files.example/${path}?token=secret`, expiresAt: "2026-11-17T04:46:00.000Z" };
    },
  };
  return { repo, read: () => row, set: (patch: Partial<WhatsAppDelivery>) => { row = { ...row, ...patch }; } };
}

const excel = Buffer.from("excel-bytes");
const documentMode = { mode: "document" as const };

describe("manifest WhatsApp delivery", () => {
  it("sends a document once and reuses the stored file", async () => {
    const state = memory(delivery());
    const send = vi.fn(async () => ({ messageId: "vac-1", whatsappMessageId: "wamid.1" }));
    const loadExcel = vi.fn(async () => ({ bytes: excel, filename: "ignored.xlsx" }));
    const sent = await executeManifestWhatsAppDelivery(state.repo, "delivery-1", {
      maxBytes: 1000,
      send,
      loadExcel,
      credentials: async () => ({ apiKey: "key", apiBaseUrl: "https://cloud.vachat.in" }),
      sendMode: documentMode,
    });
    expect(sent?.status).toBe("ACCEPTED");
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].filename).toBe("manifest_MF-20261117-001_india_post.xlsx");
    expect(send.mock.calls[0][0].mediaUrl).toContain("token=secret");
    expect(state.read().attachmentChecksum).toBe(createHash("sha256").update(excel).digest("hex"));

    state.set({ status: "RETRYING", sendPhase: null });
    const secondLoad = vi.fn(async () => ({ bytes: Buffer.from("other"), filename: "nope.xlsx" }));
    const resent = await executeManifestWhatsAppDelivery(state.repo, "delivery-1", {
      maxBytes: 1000,
      send,
      loadExcel: secondLoad,
      credentials: async () => ({ apiKey: "key", apiBaseUrl: "https://cloud.vachat.in" }),
      sendMode: documentMode,
    });
    expect(resent?.status).toBe("ACCEPTED");
    expect(secondLoad).not.toHaveBeenCalled();
  });

  it("blocks free-form documents when no template or session flag is available", async () => {
    const state = memory(delivery());
    const send = vi.fn();
    const blocked = await executeManifestWhatsAppDelivery(state.repo, "delivery-1", {
      maxBytes: 1000,
      send,
      loadExcel: async () => ({ bytes: excel, filename: "x.xlsx" }),
      credentials: async () => ({ apiKey: "key", apiBaseUrl: "https://cloud.vachat.in" }),
      sendMode: { mode: "blocked", code: "TEMPLATE_REQUIRED" },
    });
    expect(blocked?.status).toBe("FAILED");
    expect(blocked?.lastErrorCode).toBe("TEMPLATE_REQUIRED");
    expect(send).not.toHaveBeenCalled();
  });

  it("retries a 429 and records a permanent 4xx", async () => {
    const retryState = memory(delivery());
    await expect(
      executeManifestWhatsAppDelivery(retryState.repo, "delivery-1", {
        maxBytes: 1000,
        loadExcel: async () => ({ bytes: excel, filename: "x.xlsx" }),
        credentials: async () => ({ apiKey: "key", apiBaseUrl: "https://cloud.vachat.in" }),
        sendMode: documentMode,
        send: async () => {
          throw Object.assign(new Error("rate limited"), { status: 429, code: "HTTP_429" });
        },
      })
    ).rejects.toBeInstanceOf(ManifestWhatsAppRetry);
    expect(retryState.read().status).toBe("RETRYING");

    const denied = memory(delivery());
    const result = await executeManifestWhatsAppDelivery(denied.repo, "delivery-1", {
      maxBytes: 1000,
      loadExcel: async () => ({ bytes: excel, filename: "x.xlsx" }),
      credentials: async () => ({ apiKey: "key", apiBaseUrl: "https://cloud.vachat.in" }),
      sendMode: documentMode,
      send: async () => {
        throw Object.assign(new Error("bad request"), { status: 400, code: "bad_request" });
      },
    });
    expect(result?.status).toBe("FAILED");
    expect(result?.retryable).toBe(false);
  });

  it("does not send an oversized or invalid workbook", async () => {
    const oversized = memory(delivery());
    const send = vi.fn();
    const tooBig = await executeManifestWhatsAppDelivery(oversized.repo, "delivery-1", {
      maxBytes: 4,
      send,
      loadExcel: async () => ({ bytes: excel, filename: "x.xlsx" }),
      credentials: async () => ({ apiKey: "key", apiBaseUrl: "https://cloud.vachat.in" }),
      sendMode: documentMode,
    });
    expect(tooBig?.status).toBe("FAILED");
    expect(tooBig?.lastErrorCode).toBe("ATTACHMENT_TOO_LARGE");
    expect(send).not.toHaveBeenCalled();

    const invalid = memory(delivery());
    const blocked = await executeManifestWhatsAppDelivery(invalid.repo, "delivery-1", {
      maxBytes: 1000,
      send,
      loadExcel: async () => {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, "One shipment is invalid.");
      },
      credentials: async () => ({ apiKey: "key", apiBaseUrl: "https://cloud.vachat.in" }),
      sendMode: documentMode,
    });
    expect(blocked?.status).toBe("FAILED");
    expect(blocked?.lastError).toMatch(/invalid/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("cancels a reopened manifest and does not retry an ambiguous send", async () => {
    const reopened = memory(delivery(), "DRAFT", null);
    const send = vi.fn();
    const cancelled = await executeManifestWhatsAppDelivery(reopened.repo, "delivery-1", {
      maxBytes: 1000,
      send,
      loadExcel: vi.fn(),
      credentials: async () => ({ apiKey: "key", apiBaseUrl: "https://cloud.vachat.in" }),
      sendMode: documentMode,
    });
    expect(cancelled?.status).toBe("CANCELLED");
    expect(send).not.toHaveBeenCalled();

    const ambiguous = memory(
      delivery({
        status: "SENDING",
        sendPhase: "SUBMITTED",
        attemptCount: 1,
        lastAttemptAt: "2026-11-17T04:00:00.000Z",
      })
    );
    const now = new Date("2026-11-17T04:30:00.000Z");
    const unknown = await executeManifestWhatsAppDelivery(ambiguous.repo, "delivery-1", {
      now,
      maxBytes: 1000,
      send,
      loadExcel: vi.fn(),
      credentials: async () => ({ apiKey: "key", apiBaseUrl: "https://cloud.vachat.in" }),
      sendMode: documentMode,
    });
    expect(unknown?.status).toBe("UNKNOWN");
    expect(send).not.toHaveBeenCalled();
  });

  it("marks UNKNOWN when the provider times out after submit", async () => {
    const state = memory(delivery());
    const result = await executeManifestWhatsAppDelivery(state.repo, "delivery-1", {
      maxBytes: 1000,
      loadExcel: async () => ({ bytes: excel, filename: "x.xlsx" }),
      credentials: async () => ({ apiKey: "key", apiBaseUrl: "https://cloud.vachat.in" }),
      sendMode: documentMode,
      send: async () => {
        throw Object.assign(new Error("aborted"), { name: "TimeoutError", code: "ETIMEDOUT" });
      },
    });
    expect(result?.status).toBe("UNKNOWN");
    expect(result?.retryable).toBe(false);
  });
});
