import type { WhatsAppDeliveryStatus } from "@/modules/manifest-whatsapp/types";

const RANK: Record<WhatsAppDeliveryStatus, number> = {
  PENDING: 0,
  QUEUED: 1,
  SENDING: 2,
  RETRYING: 2,
  UNKNOWN: 2,
  ACCEPTED: 3,
  SENT: 4,
  DELIVERED: 5,
  FAILED: 90,
  CANCELLED: 90,
};

export function mapVachatWebhookStatus(status: string): WhatsAppDeliveryStatus | null {
  const key = status.toLowerCase();
  if (key === "failed") return "FAILED";
  if (key === "delivered" || key === "read") return "DELIVERED";
  if (key === "sent") return "SENT";
  return null;
}

export function canAdvanceWhatsAppStatus(current: WhatsAppDeliveryStatus, next: WhatsAppDeliveryStatus) {
  if (current === next) return false;
  if (current === "DELIVERED" || current === "CANCELLED") return false;
  if (current === "FAILED" && next !== "DELIVERED") return false;
  return RANK[next] > RANK[current];
}

export function applyWhatsAppProviderStatus(current: WhatsAppDeliveryStatus, providerStatus: string) {
  const mapped = mapVachatWebhookStatus(providerStatus);
  if (!mapped) return current;
  return canAdvanceWhatsAppStatus(current, mapped) ? mapped : current;
}
