import type { SupabaseClient } from "@supabase/supabase-js";
import { applyWhatsAppProviderStatus } from "@/modules/manifest-whatsapp/status";
import { mapDelivery } from "@/modules/manifest-whatsapp/store";

export async function applyManifestWhatsAppWebhookStatus(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    status: string;
    vachatMessageId?: string | null;
    whatsappMessageId?: string | null;
  }
) {
  const ids = [input.vachatMessageId, input.whatsappMessageId]
    .map((value) => String(value ?? "").trim())
    .filter((value) => /^[A-Za-z0-9._:-]{1,128}$/.test(value));
  if (!ids.length) return { updated: false };

  const [byVachat, byWhatsapp] = await Promise.all([
    supabase
      .from("manifest_whatsapp_deliveries")
      .select("*")
      .eq("organization_id", organizationId)
      .in("vachat_message_id", ids)
      .limit(5),
    supabase
      .from("manifest_whatsapp_deliveries")
      .select("*")
      .eq("organization_id", organizationId)
      .in("whatsapp_message_id", ids)
      .limit(5),
  ]);
  const merged = [...(byVachat.data ?? []), ...(byWhatsapp.data ?? [])];
  const seen = new Set<string>();
  const data = merged.filter((row) => {
    const id = String((row as { id?: string }).id ?? "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (byVachat.error || byWhatsapp.error || !data.length) return { updated: false };

  let updated = false;
  for (const row of data) {
    const current = mapDelivery(row);
    const next = applyWhatsAppProviderStatus(current.status, input.status);
    if (next === current.status) continue;
    const failed = next === "FAILED";
    await supabase
      .from("manifest_whatsapp_deliveries")
      .update({
        status: next,
        last_error: failed ? "WhatsApp delivery failed." : null,
        last_error_code: failed ? "VACHAT_FAILED" : null,
        vachat_message_id: input.vachatMessageId || current.vachatMessageId,
        whatsapp_message_id: input.whatsappMessageId || current.whatsappMessageId,
      })
      .eq("id", current.id)
      .eq("organization_id", organizationId);
    updated = true;
  }
  return { updated };
}
