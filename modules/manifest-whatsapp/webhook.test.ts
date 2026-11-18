import { describe, expect, it } from "vitest";
import { applyManifestWhatsAppWebhookStatus } from "@/modules/manifest-whatsapp/webhook";

function row(status: string) {
  return {
    id: "d1",
    organization_id: "org-1",
    manifest_id: "m1",
    trigger_type: "AUTO",
    manifest_closed_at: "2026-11-17T00:00:00.000Z",
    merchant_name: "Store",
    manifest_number: "MF-1",
    manifest_date: "2026-11-17",
    office_id: null,
    office_name: null,
    shipment_count: 1,
    recipient: "+919876543210",
    recipient_name: null,
    attachment_filename: "file.xlsx",
    attachment_path: "org-1/d1.xlsx",
    attachment_checksum: "abc",
    signed_url_expires_at: null,
    status,
    send_phase: null,
    attempt_count: 1,
    max_attempts: 5,
    retryable: false,
    last_error: null,
    last_error_code: null,
    vachat_message_id: "vac-1",
    whatsapp_message_id: "wamid.1",
    background_job_id: "job",
    batch_id: "b1",
    batch_index: 0,
    batch_count: 1,
    file_index: 0,
    idempotency_key: "auto:1",
    created_at: "2026-11-17T00:00:00.000Z",
    queued_at: null,
    last_attempt_at: null,
    sent_at: "2026-11-17T00:01:00.000Z",
  };
}

function supabaseWith(status: string, updates: unknown[]) {
  const query = {
    select: () => ({
      eq: () => ({
        in: () => ({
          limit: async () => ({ data: [row(status)], error: null }),
        }),
      }),
    }),
    update: (patch: unknown) => ({
      eq: () => ({
        eq: async () => {
          updates.push(patch);
          return { error: null };
        },
      }),
    }),
  };
  return { from: () => query };
}

describe("manifest WhatsApp webhook correlation", () => {
  it("advances ACCEPTED to DELIVERED from a verified provider event", async () => {
    const updates: unknown[] = [];
    const result = await applyManifestWhatsAppWebhookStatus(supabaseWith("ACCEPTED", updates) as never, "org-1", {
      status: "delivered",
      vachatMessageId: "vac-1",
      whatsappMessageId: "wamid.1",
    });
    expect(result.updated).toBe(true);
    expect(updates[0]).toMatchObject({ status: "DELIVERED" });
  });

  it("ignores a duplicate delivered event that cannot regress", async () => {
    const updates: unknown[] = [];
    const result = await applyManifestWhatsAppWebhookStatus(supabaseWith("DELIVERED", updates) as never, "org-1", {
      status: "sent",
      vachatMessageId: "vac-1",
    });
    expect(result.updated).toBe(false);
    expect(updates).toHaveLength(0);
  });
});
