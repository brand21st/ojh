import { indiaPostMobile } from "@/modules/india-post/endpoints";
import { wrapIndiaPostAddressLines } from "@/modules/india-post/address-lines";
import type { OrganizationLabelSender } from "@/modules/organizations/label-sender";

export type IndiaPostMerchantSenderFields = {
  senderName: string;
  senderCompany: string;
  senderLine1: string;
  senderLine2: string;
  senderCity: string;
  senderState: string;
  senderPin: string;
  senderMobile: string;
};

/** Maps the merchant identity onto CEPT sender fields. Does not copy the booking office. */
export function indiaPostMerchantSenderFields(identity: OrganizationLabelSender): IndiaPostMerchantSenderFields {
  return {
    senderName: identity.name,
    senderCompany: identity.company,
    senderLine1: identity.line1,
    senderLine2: identity.line2,
    senderCity: identity.city || "",
    senderState: identity.state || "",
    senderPin: identity.pincode || "",
    senderMobile: indiaPostMobile(identity.phone) || "",
  };
}

const NAME_MAX = 80;

export function indiaPostMerchantSenderMissing(identity: OrganizationLabelSender) {
  const fields = indiaPostMerchantSenderFields(identity);
  const missing: string[] = [];
  if (!fields.senderName.trim()) missing.push("Sender Name");
  else if (fields.senderName.trim().length > NAME_MAX) missing.push("Sender Name (too long)");
  if (!fields.senderCompany.trim()) missing.push("Company Name");
  else if (fields.senderCompany.trim().length > NAME_MAX) missing.push("Company Name (too long)");
  if (!fields.senderLine1.trim()) missing.push("Address Line 1");
  if (!fields.senderCity.trim()) missing.push("Sender City");
  else if (fields.senderCity.trim().length > NAME_MAX) missing.push("Sender City (too long)");
  if (!/^[1-9][0-9]{5}$/.test(fields.senderPin)) missing.push("Sender PIN Code");
  if (!fields.senderMobile) missing.push("Sender Mobile");
  if (fields.senderState.trim() && fields.senderState.trim().length > NAME_MAX) missing.push("Sender State (too long)");
  const street = wrapIndiaPostAddressLines(fields.senderLine1, fields.senderLine2, "", fields.senderCity);
  if (street.overflow) missing.push("Sender Address (too long)");
  return missing;
}

export function pickupForShipment<T extends { id?: string | null }>(
  shipmentPickupId: string | null | undefined,
  pickups: T[],
  fallback: T | null
): T | null {
  const id = String(shipmentPickupId ?? "").trim();
  if (id) {
    const match = pickups.find((row) => String(row.id ?? "") === id);
    if (match) return match;
  }
  return fallback;
}
