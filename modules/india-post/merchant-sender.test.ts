import { describe, expect, it } from "vitest";
import { mapShipmentToArticle } from "@/modules/india-post/article-mapper";
import { validateIndiaPostArticle } from "@/modules/india-post/article-validator";
import { serializeIndiaPostBookingArticle } from "@/modules/india-post/booking-payload";
import { ARTICLE_DETAILS_HEADERS, articleDetailsRow } from "@/modules/india-post/article-details-sheet";
import {
  indiaPostMerchantSenderFields,
  indiaPostMerchantSenderMissing,
  pickupForShipment,
} from "@/modules/india-post/merchant-sender";
import { MANIFEST_EXPORT_HEADERS, manifestExportRows } from "@/modules/manifests/export";
import { organizationLabelSender } from "@/modules/organizations/label-sender";

const completeOrg = {
  name: "Kerlaz Stores",
  phone: "9876543210",
  line1: "NH 85",
  line2: "Near SO",
  city: "Kolenchery",
  state: "Kerala",
  pincode: "682311",
};

const officeOrigin = { city: "Mysuru", state: "Karnataka", pincode: "570001" };

function articleFromIdentity(identity = organizationLabelSender(completeOrg)) {
  const sender = indiaPostMerchantSenderFields(identity);
  return mapShipmentToArticle({
    serviceCode: "SP_INLAND_PARCEL",
    customerId: "1788590988",
    contractId: "41793509",
    barcode: "ET214330016IN",
    officeId: "21360043",
    originPin: officeOrigin.pincode,
    weightGrams: 500,
    lengthCm: 20,
    widthCm: 15,
    heightCm: 10,
    senderName: sender.senderName,
    senderCompany: sender.senderCompany,
    senderLine1: sender.senderLine1,
    senderLine2: sender.senderLine2,
    senderCity: sender.senderCity,
    senderState: sender.senderState,
    senderPin: sender.senderPin,
    senderMobile: sender.senderMobile,
    receiverName: "Aditha",
    receiverLine1: "OM SHAKTHI",
    receiverCity: "Bangalore",
    receiverState: "Karnataka",
    receiverPin: "560062",
    receiverMobile: "9964903319",
    paymentMode: "PREPAID",
    strictDimensions: true,
  });
}

describe("indiaPost merchant sender", () => {
  it("maps complete merchant identity and does not copy the booking office", () => {
    const identity = organizationLabelSender(completeOrg);
    expect(indiaPostMerchantSenderMissing(identity)).toEqual([]);
    const payload = serializeIndiaPostBookingArticle(articleFromIdentity(identity) as never);
    expect(payload.sender_name).toBe("Kerlaz Stores");
    expect(payload.sender_company).toBe("Kerlaz Stores");
    expect(payload.sender_add_line_1).toBe("NH 85");
    expect(payload.sender_city).toBe("Kolenchery");
    expect(payload.sender_state).toBe("Kerala");
    expect(payload.sender_pincode).toBe("682311");
    expect(payload.sender_mobile_no).toBe("9876543210");
    expect(payload.drop_off_pincode).toBe("570001");
    expect(payload.sender_pincode).not.toBe(payload.drop_off_pincode);
  });

  it("reports missing sender name", () => {
    const identity = organizationLabelSender({ ...completeOrg, name: "" }, { contact_name: "", name: "" });
    expect(indiaPostMerchantSenderMissing(identity)).toContain("Sender Name");
  });

  it("reports missing company name when only a shop name exists", () => {
    const identity = organizationLabelSender(null, null, "Priya Stores");
    expect(identity.name).toBe("Priya Stores");
    expect(indiaPostMerchantSenderMissing(identity)).toContain("Company Name");
  });

  it("reports missing address line 1", () => {
    expect(indiaPostMerchantSenderMissing(organizationLabelSender({ ...completeOrg, line1: "", line2: "" }))).toContain(
      "Address Line 1"
    );
  });

  it("reports invalid sender PIN codes", () => {
    expect(indiaPostMerchantSenderMissing(organizationLabelSender({ ...completeOrg, pincode: "68231" }))).toContain(
      "Sender PIN Code"
    );
    expect(indiaPostMerchantSenderMissing(organizationLabelSender({ ...completeOrg, pincode: "068231" }))).toContain(
      "Sender PIN Code"
    );
  });

  it("reports invalid sender mobiles", () => {
    expect(indiaPostMerchantSenderMissing(organizationLabelSender({ ...completeOrg, phone: "5876543210" }))).toContain(
      "Sender Mobile"
    );
    expect(indiaPostMerchantSenderMissing(organizationLabelSender({ ...completeOrg, phone: "98765" }))).toContain(
      "Sender Mobile"
    );
  });

  it("reports sender address overflow instead of truncating", () => {
    const identity = organizationLabelSender({
      ...completeOrg,
      line1: "A".repeat(90),
      line2: "B".repeat(90),
    });
    expect(indiaPostMerchantSenderMissing(identity)).toContain("Sender Address (too long)");
    const issues = validateIndiaPostArticle(articleFromIdentity(identity));
    expect(issues.some((issue) => issue.field === "sender_add_line_1")).toBe(true);
  });

  it("keeps an explicitly selected pickup instead of the default", () => {
    const defaultPickup = { id: "default", name: "Default warehouse", city: "Kochi", pincode: "682001", line1: "Bay 1" };
    const selected = { id: "alt", name: "Alt warehouse", contact_name: "Desk", city: "Thrissur", pincode: "680001", line1: "Bay 9" };
    const chosen = pickupForShipment("alt", [selected, defaultPickup], defaultPickup);
    const identity = organizationLabelSender({ name: "Kerlaz Stores", phone: "9876543210" }, chosen);
    expect(identity.city).toBe("Thrissur");
    expect(identity.pincode).toBe("680001");
    expect(identity.line1).toBe("Bay 9");
    expect(pickupForShipment(null, [selected, defaultPickup], defaultPickup)?.id).toBe("default");
  });

  it("does not leak another organization's pickup", () => {
    const own = { id: "own", organization_id: "org-a", line1: "Own road", city: "Kochi", pincode: "682311" };
    const other = { id: "other", organization_id: "org-b", line1: "Other road", city: "Delhi", pincode: "110001" };
    expect(pickupForShipment("other", [own], own)?.id).toBe("own");
  });
});

describe("Excel sender mapping", () => {
  it("keeps the 26-column handover headers and fills merchant city, state, PIN and mobile", () => {
    expect(MANIFEST_EXPORT_HEADERS).toHaveLength(26);
    const rows = manifestExportRows(
      {
        lines: [
          {
            barcode: "EB116121154IN",
            orderNumber: "PB-1",
            consignee: "Aditha",
            city: "Bangalore",
            state: "Karnataka",
            pincode: "560062",
            company: null,
            line1: "OM SHAKTHI",
            line2: null,
            line3: null,
            phone: "9964903319",
            email: null,
            lengthCm: 18,
            widthCm: 10,
            heightCm: 10,
            serviceCode: "SP_INLAND_PARCEL",
            serviceLabel: "Speed Post",
            weightGrams: 100,
            paymentMode: "PREPAID",
            codAmount: 0,
            tariffAmount: 31,
            shipmentId: "s1",
            shipmentStatus: "MANIFEST_READY",
            addedAt: "2026-11-14T05:00:00Z",
            scanned: null,
          },
        ],
      } as never,
      { city: "Kolenchery", state: "Kerala", pincode: "682311", phone: "9876543210" }
    );
    expect(rows[0]).toHaveLength(26);
    expect(rows[0]![21]).toBe("Kolenchery");
    expect(rows[0]![22]).toBe("Kerala");
    expect(rows[0]![23]).toBe("682311");
    expect(rows[0]![24]).toBe("9876543210");
  });

  it("keeps the 48-column ArticleDetails workbook headers and merchant sender cells", () => {
    expect(ARTICLE_DETAILS_HEADERS).toHaveLength(49);
    const row = articleDetailsRow(articleFromIdentity(), 1);
    expect(row).toHaveLength(49);
    expect(row[ARTICLE_DETAILS_HEADERS.indexOf("SENDER NAME")]).toBe("Kerlaz Stores");
    expect(row[ARTICLE_DETAILS_HEADERS.indexOf("SENDER COMPANY NAME")]).toBe("Kerlaz Stores");
    expect(row[ARTICLE_DETAILS_HEADERS.indexOf("SENDER CITY")]).toBe("Kolenchery");
    expect(row[ARTICLE_DETAILS_HEADERS.indexOf("SENDER PINCODE")]).toBe("682311");
    expect(row[ARTICLE_DETAILS_HEADERS.indexOf("SENDER ADD LINE 1")]).toBe("NH 85");
  });
});
