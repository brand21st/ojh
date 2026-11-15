import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { permissionForTenantRoute } from "@/lib/api/v1-permissions";
import { BOOKING_JOB_TYPES, OTHER_JOB_TYPES } from "@/lib/jobs/job-lanes";
import { hasPermission } from "@/lib/permissions/rbac";
import { toPublicSettings } from "@/modules/manifest-email/settings";
import { toPublicDelivery } from "@/modules/manifest-email/types";
import type { EmailDelivery } from "@/modules/manifest-email/types";
import { JOB_TYPES } from "@/types/domain";

describe("manifest email security", () => {
  it("keeps settings changes with automation managers and sends with manifest writers", () => {
    expect(permissionForTenantRoute("PATCH", "manifests/email-settings", ["manifests", "email-settings"])).toBe(
      "automation.manage"
    );
    expect(permissionForTenantRoute("GET", "manifests/id/email-deliveries", ["manifests", "id", "email-deliveries"])).toBe(
      "manifests.read"
    );
    expect(permissionForTenantRoute("POST", "manifests/id/email", ["manifests", "id", "email"])).toBe("manifests.write");
    expect(hasPermission("OPERATOR", "automation.manage")).toBe(false);
    expect(hasPermission("MANAGER", "automation.manage")).toBe(true);
    expect(hasPermission("VIEWER", "manifests.write")).toBe(false);
  });

  it("does not put manifest email on the booking lane or return mail secrets", () => {
    expect(JOB_TYPES).toContain("manifest-email");
    expect(BOOKING_JOB_TYPES).not.toContain("manifest-email");
    expect(OTHER_JOB_TYPES).toContain("manifest-email");
    const settings = toPublicSettings(
      { autoSendEnabled: false, recipients: [], officeOverrides: {}, replyTo: null, ccRecipients: [] },
      []
    );
    expect(JSON.stringify(settings)).not.toMatch(/password|smtp_?host|MANIFEST_SMTP/i);
    const delivery = {
      id: "d",
      organizationId: "org-a",
      manifestId: "m",
      triggerType: "MANUAL",
      manifestClosedAt: "2026-11-15T00:00:00.000Z",
      merchantName: "Store",
      manifestNumber: "MF-1",
      manifestDate: "2026-11-15",
      officeId: null,
      officeName: "",
      shipmentCount: 1,
      recipients: ["a@example.com"],
      cc: [],
      replyTo: null,
      recipientHash: "hash",
      subject: "subject",
      templateVersion: "manifest-email-v1",
      filename: "file.xlsx",
      attachmentPath: "org-a/d.xlsx",
      attachmentChecksum: "abc",
      status: "SENT",
      smtpPhase: null,
      attemptCount: 1,
      maxAttempts: 5,
      retryable: false,
      lastError: null,
      lastErrorCode: null,
      smtpMessageId: "msg",
      backgroundJobId: "job",
      idempotencyKey: "manual:1",
      createdAt: "2026-11-15T00:00:00.000Z",
      queuedAt: null,
      lastAttemptAt: null,
      sentAt: null,
    } satisfies EmailDelivery;
    const pub = toPublicDelivery(delivery);
    expect(pub).not.toHaveProperty("attachmentPath");
    expect(pub).not.toHaveProperty("organizationId");
    expect(JSON.stringify(pub)).not.toContain("org-a/d.xlsx");
  });

  it("does not import an India Post booking client from the email path", () => {
    for (const file of ["deliver.ts", "attempt.ts", "service.ts", "smtp.ts"]) {
      const source = readFileSync(`modules/manifest-email/${file}`, "utf8");
      expect(source).not.toMatch(/india-post\/provider|bookArticles|createIndiaPostBooking/);
      expect(source).not.toMatch(/from "@\/modules\/india-post\/booking"/);
    }
  });
});
