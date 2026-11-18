import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobPayload } from "@/lib/queue/queues";
import { manifestWhatsAppMaxBytes } from "@/modules/manifest-whatsapp/config";
import { executeManifestWhatsAppDelivery } from "@/modules/manifest-whatsapp/attempt";
import { sendManifestWhatsAppDocument } from "@/modules/manifest-whatsapp/send";
import { createWhatsAppDeliveryRepository } from "@/modules/manifest-whatsapp/store";
import { exportManifestIndiaPostExcel } from "@/modules/manifests/india-post-excel";
import { resolveVachatSendCredentials } from "@/modules/vachat/platform-config";

export async function deliverManifestWhatsAppJob(supabase: SupabaseClient, payload: JobPayload) {
  if (!payload.entityId) {
    throw Object.assign(new Error("Manifest WhatsApp delivery id is missing."), { code: "VALIDATION_ERROR" });
  }
  await executeManifestWhatsAppDelivery(createWhatsAppDeliveryRepository(supabase), payload.entityId, {
    maxBytes: manifestWhatsAppMaxBytes(),
    send: sendManifestWhatsAppDocument,
    loadExcel: async (organizationId, manifestId) => {
      const file = await exportManifestIndiaPostExcel(supabase, organizationId, manifestId);
      return { bytes: Buffer.from(file.bytes), filename: file.filename };
    },
    credentials: async (organizationId) => {
      const { data } = await supabase
        .from("vachat_connections")
        .select("*")
        .eq("organization_id", organizationId)
        .maybeSingle();
      return resolveVachatSendCredentials(organizationId, data);
    },
  });
}
