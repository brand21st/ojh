import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { manifestEmailEnabled, manifestEmailMaxRecipients } from "@/modules/manifest-email/config";
import {
  assertAutoSendRecipients,
  fillOfficeDisplayName,
  MAX_CC,
  normalizeEmailAddress,
  normalizeOfficeOverrides,
  normalizeRecipients,
} from "@/modules/manifest-email/recipients";

export type ManifestEmailSettings = {
  autoSendEnabled: boolean;
  recipients: string[];
  officeOverrides: Record<string, string[]>;
  replyTo: string | null;
  ccRecipients: string[];
};

export type ManifestEmailOffice = { id: string; name: string };

export type PublicManifestEmailSettings = ManifestEmailSettings & {
  offices: ManifestEmailOffice[];
  deliveryEnabled: boolean;
  maxRecipients: number;
  trigger: "On manifest finalization";
  attachment: "India Post Excel (.xlsx)";
};

const EMPTY: ManifestEmailSettings = {
  autoSendEnabled: false,
  recipients: [],
  officeOverrides: {},
  replyTo: null,
  ccRecipients: [],
};

export function toPublicSettings(settings: ManifestEmailSettings, offices: ManifestEmailOffice[]): PublicManifestEmailSettings {
  return {
    ...settings,
    offices,
    deliveryEnabled: manifestEmailEnabled(),
    maxRecipients: manifestEmailMaxRecipients(),
    trigger: "On manifest finalization",
    attachment: "India Post Excel (.xlsx)",
  };
}

function mapSettings(row: {
  auto_send_enabled?: boolean | null;
  recipients?: string[] | null;
  office_overrides?: unknown;
  reply_to?: string | null;
  cc_recipients?: string[] | null;
} | null): ManifestEmailSettings {
  if (!row) return { ...EMPTY, officeOverrides: {} };
  const overrides = row.office_overrides && typeof row.office_overrides === "object" && !Array.isArray(row.office_overrides)
    ? (row.office_overrides as Record<string, unknown>)
    : {};
  const officeOverrides: Record<string, string[]> = {};
  for (const [officeId, recipients] of Object.entries(overrides)) {
    officeOverrides[officeId] = Array.isArray(recipients)
      ? recipients.filter((item): item is string => typeof item === "string")
      : [];
  }
  return {
    autoSendEnabled: Boolean(row.auto_send_enabled),
    recipients: row.recipients ?? [],
    officeOverrides,
    replyTo: row.reply_to ?? null,
    ccRecipients: row.cc_recipients ?? [],
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

export async function getManifestEmailSettings(supabase: SupabaseClient, organizationId: string) {
  const { data, error } = await supabase
    .from("manifest_email_settings")
    .select("auto_send_enabled, recipients, office_overrides, reply_to, cc_recipients")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  return toPublicSettings(mapSettings(data), await listOffices(supabase, organizationId));
}

export async function readManifestEmailSettings(supabase: SupabaseClient, organizationId: string) {
  const { data, error } = await supabase
    .from("manifest_email_settings")
    .select("auto_send_enabled, recipients, office_overrides, reply_to, cc_recipients")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  return mapSettings(data);
}

export async function updateManifestEmailSettings(
  supabase: SupabaseClient,
  organizationId: string,
  userId: string | null,
  input: unknown
) {
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const max = manifestEmailMaxRecipients();
  const recipients = normalizeRecipients(body.recipients ?? [], max);
  const officeOverrides = normalizeOfficeOverrides(body.officeOverrides ?? body.office_overrides ?? {}, max);
  const ccRecipients = normalizeRecipients(body.ccRecipients ?? body.cc_recipients ?? [], MAX_CC);
  const replyRaw = body.replyTo ?? body.reply_to;
  let replyTo: string | null = null;
  if (typeof replyRaw === "string" && replyRaw.trim()) {
    replyTo = normalizeEmailAddress(replyRaw);
    if (!replyTo) throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Enter a valid reply-to email address.");
  }
  const autoSendEnabled = Boolean(body.autoSendEnabled ?? body.auto_send_enabled);
  if (autoSendEnabled) assertAutoSendRecipients(recipients);

  const { error } = await supabase.from("manifest_email_settings").upsert(
    {
      organization_id: organizationId,
      auto_send_enabled: autoSendEnabled,
      recipients,
      office_overrides: officeOverrides,
      reply_to: replyTo,
      cc_recipients: ccRecipients,
      updated_by: userId,
    },
    { onConflict: "organization_id" }
  );
  if (error) throw new AppError(ERROR_CODES.VALIDATION_ERROR, error.message);
  return getManifestEmailSettings(supabase, organizationId);
}
