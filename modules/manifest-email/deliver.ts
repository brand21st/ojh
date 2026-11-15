import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobPayload } from "@/lib/queue/queues";
import { manifestEmailMaxBytes } from "@/modules/manifest-email/config";
import { executeManifestEmailDelivery } from "@/modules/manifest-email/attempt";
import { createDeliveryRepository } from "@/modules/manifest-email/store";
import { sendManifestMail } from "@/modules/manifest-email/smtp";
import { exportManifestIndiaPostExcel } from "@/modules/manifests/india-post-excel";

export async function deliverManifestEmailJob(supabase: SupabaseClient, payload: JobPayload) {
  if (!payload.entityId) {
    throw Object.assign(new Error("Manifest email delivery id is missing."), { code: "VALIDATION_ERROR" });
  }
  await executeManifestEmailDelivery(createDeliveryRepository(supabase), payload.entityId, {
    maxBytes: manifestEmailMaxBytes(),
    send: sendManifestMail,
    loadExcel: async (organizationId, manifestId) => {
      const file = await exportManifestIndiaPostExcel(supabase, organizationId, manifestId);
      return { bytes: Buffer.from(file.bytes), filename: file.filename };
    },
  });
}
