import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { permissionForTenantRoute } from "@/lib/api/v1-permissions";
import { BOOKING_JOB_TYPES, OTHER_JOB_TYPES } from "@/lib/jobs/job-lanes";
import { hasPermission } from "@/lib/permissions/rbac";
import { toPublicSettings } from "@/modules/manifest-whatsapp/settings";
import { toPublicDelivery } from "@/modules/manifest-whatsapp/types";
import type { WhatsAppDelivery } from "@/modules/manifest-whatsapp/types";
import { JOB_TYPES } from "@/types/domain";

describe("manifest WhatsApp security", () => {
  it("keeps settings changes with automation managers and sends with manifest writers", () => {
    expect(permissionForTenantRoute("PATCH", "manifests/whatsapp-settings", ["manifests", "whatsapp-settings"])).toBe(
      "automation.manage"
    );
    expect(
      permissionForTenantRoute("POST", "manifests/whatsapp-settings/test", ["manifests", "whatsapp-settings", "test"])
    ).toBe("automation.manage");
    expect(
      permissionForTenantRoute("GET", "manifests/id/whatsapp-deliveries", ["manifests", "id", "whatsapp-deliveries"])
    ).toBe("manifests.read");
    expect(permissionForTenantRoute("POST", "manifests/id/whatsapp", ["manifests", "id", "whatsapp"])).toBe(
      "manifests.write"
    );
    expect(hasPermission("OPERATOR", "automation.manage")).toBe(false);
    expect(hasPermission("MANAGER", "automation.manage")).toBe(true);
    expect(hasPermission("VIEWER", "manifests.write")).toBe(false);
  });

  it("does not put WhatsApp jobs on the booking lane or return storage paths", () => {
    expect(JOB_TYPES).toContain("manifest-whatsapp");
    expect(BOOKING_JOB_TYPES).not.toContain("manifest-whatsapp");
    expect(OTHER_JOB_TYPES).toContain("manifest-whatsapp");
    const settings = toPublicSettings({ autoSendEnabled: false, recipients: [], officeOverrides: {} }, []);
    expect(JSON.stringify(settings)).not.toMatch(/apiKey|wacrm_|service_role|token=/i);
    const delivery = {
      id: "d",
      organizationId: "org-a",
      manifestId: "m",
      triggerType: "MANUAL",
      manifestClosedAt: "2026-11-17T00:00:00.000Z",
      merchantName: "Store",
      manifestNumber: "MF-1",
      manifestDate: "2026-11-17",
      officeId: null,
      officeName: "",
      shipmentCount: 1,
      recipient: "+919876543210",
      recipientName: "Office",
      filename: "file.xlsx",
      attachmentPath: "org-a/d.xlsx",
      attachmentChecksum: "abc",
      signedUrlExpiresAt: "https://files.example/obj?token=secret",
      status: "ACCEPTED",
      sendPhase: null,
      attemptCount: 1,
      maxAttempts: 5,
      retryable: false,
      lastError: null,
      lastErrorCode: null,
      vachatMessageId: "vac",
      whatsappMessageId: "wamid",
      backgroundJobId: "job",
      batchId: "b",
      batchIndex: 0,
      batchCount: 1,
      fileIndex: 0,
      idempotencyKey: "manual:1",
      createdAt: "2026-11-17T00:00:00.000Z",
      queuedAt: null,
      lastAttemptAt: null,
      sentAt: null,
    } satisfies WhatsAppDelivery;
    const pub = toPublicDelivery(delivery);
    expect(pub).not.toHaveProperty("attachmentPath");
    expect(pub).not.toHaveProperty("organizationId");
    expect(JSON.stringify(pub)).not.toContain("org-a/d.xlsx");
    expect(JSON.stringify(pub)).not.toContain("token=secret");
  });

  it("does not import an India Post booking client from the WhatsApp path", () => {
    for (const file of ["deliver.ts", "attempt.ts", "service.ts", "send.ts"]) {
      const source = readFileSync(`modules/manifest-whatsapp/${file}`, "utf8");
      expect(source).not.toMatch(/india-post\/provider|bookArticles|createIndiaPostBooking/);
      expect(source).not.toMatch(/from "@\/modules\/india-post\/booking"/);
      expect(source).not.toMatch(/vachat-notify/);
    }
  });
});
