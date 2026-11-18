import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { fillOfficeDisplayName } from "@/modules/manifest-email/recipients";
import {
  manifestWhatsAppEnabled,
  manifestWhatsAppMaxRecipients,
  manifestWhatsAppSessionDocumentsEnabled,
  manifestWhatsAppTemplateName,
} from "@/modules/manifest-whatsapp/config";
import { MANIFEST_WHATSAPP_MAX_FILES_PER_BATCH } from "@/modules/manifest-whatsapp/batch";
import {
  assertAutoSendRecipients,
  normalizeOfficeOverrides,
  normalizeWhatsAppRecipients,
  type WhatsAppRecipient,
} from "@/modules/manifest-whatsapp/recipients";
import type { PublicWhatsAppSettings, WhatsAppDeliveryStatus } from "@/modules/manifest-whatsapp/types";

export type ManifestWhatsAppSettings = {
  autoSendEnabled: boolean;
  recipients: WhatsAppRecipient[];
  officeOverrides: Record<string, WhatsAppRecipient[]>;
};

const EMPTY: ManifestWhatsAppSettings = {
  autoSendEnabled: false,
  recipients: [],
  officeOverrides: {},
};

export function toPublicSettings(
  settings: ManifestWhatsAppSettings,
  offices: { id: string; name: string }[],
  last?: { status: WhatsAppDeliveryStatus | null; sentAt: string | null }
): PublicWhatsAppSettings {
  return {
    ...settings,
    offices,
    deliveryEnabled: manifestWhatsAppEnabled(),
    sessionDocumentsEnabled: manifestWhatsAppSessionDocumentsEnabled(),
    templateConfigured: Boolean(manifestWhatsAppTemplateName()),
    maxRecipients: manifestWhatsAppMaxRecipients(),
    maxFilesPerBatch: MANIFEST_WHATSAPP_MAX_FILES_PER_BATCH,
    lastStatus: last?.status ?? null,
    lastSentAt: last?.sentAt ?? null,
    trigger: "On manifest finalization",
    attachment: "India Post Excel (.xlsx)",
  };
}

function mapSettings(row: {
  auto_send_enabled?: boolean | null;
  recipients?: unknown;
  office_overrides?: unknown;
} | null): ManifestWhatsAppSettings {
  if (!row) return { ...EMPTY, officeOverrides: {} };
  return {
    autoSendEnabled: Boolean(row.auto_send_enabled),
    recipients: normalizeWhatsAppRecipients(row.recipients ?? [], 25),
    officeOverrides: normalizeOfficeOverrides(row.office_overrides ?? {}, 25),
  };
}

async function listOffices(supabase: SupabaseClient, organizationId: string) {
  const { data, error } = await supabase
    .from("manifests")
    .select("office_id, office_name")
    .eq("organization_id", organizationId)
    .not("office_id", "is", null)
    .limit(300);
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  const { data: connection } = await supabase
    .from("india_post_connections")
    .select("pickup_dropoff_office_id, pickup_dropoff_office_name, pickup_office_id, pickup_office_name")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const offices = new Map<string, string>();
  for (const row of data ?? []) {
    const id = String(row.office_id ?? "").trim();
    if (!id || offices.has(id)) continue;
    offices.set(id, fillOfficeDisplayName(id, row.office_name, connection));
  }
  return [...offices.entries()].map(([id, name]) => ({ id, name }));
}

export async function getManifestWhatsAppSettings(supabase: SupabaseClient, organizationId: string) {
  const { data, error } = await supabase
    .from("manifest_whatsapp_settings")
    .select("auto_send_enabled, recipients, office_overrides")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  const { data: last } = await supabase
    .from("manifest_whatsapp_deliveries")
    .select("status, sent_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return toPublicSettings(mapSettings(data), await listOffices(supabase, organizationId), {
    status: (last?.status as WhatsAppDeliveryStatus | undefined) ?? null,
    sentAt: last?.sent_at ?? null,
  });
}

export async function readManifestWhatsAppSettings(supabase: SupabaseClient, organizationId: string) {
  const { data, error } = await supabase
    .from("manifest_whatsapp_settings")
    .select("auto_send_enabled, recipients, office_overrides")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  return mapSettings(data);
}

export async function updateManifestWhatsAppSettings(
  supabase: SupabaseClient,
  organizationId: string,
  userId: string | null,
  input: unknown
) {
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const max = manifestWhatsAppMaxRecipients();
  const recipients = normalizeWhatsAppRecipients(body.recipients ?? [], max);
  const officeOverrides = normalizeOfficeOverrides(body.officeOverrides ?? body.office_overrides ?? {}, max);
  const autoSendEnabled = Boolean(body.autoSendEnabled ?? body.auto_send_enabled);
  if (autoSendEnabled) assertAutoSendRecipients(recipients);

  const { error } = await supabase.from("manifest_whatsapp_settings").upsert(
    {
      organization_id: organizationId,
      auto_send_enabled: autoSendEnabled,
      recipients,
      office_overrides: officeOverrides,
      updated_by: userId,
    },
    { onConflict: "organization_id" }
  );
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  return getManifestWhatsAppSettings(supabase, organizationId);
}
