import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readWorkbook } from "@/lib/xlsx/read";
import { bookedShipmentRow } from "@/modules/booking-queue/export";
import {
  ARTICLE_DETAILS_HEADERS,
  articleDetailsRow,
  articleDetailsWorkbook,
} from "@/modules/india-post/article-details-sheet";
import { mapShipmentToArticle } from "@/modules/india-post/article-mapper";
import { organizationLabelSender } from "@/modules/organizations/label-sender";
import { MANIFEST_EXPORT_HEADERS } from "@/modules/manifests/export";

const FIXTURE = path.join(process.cwd(), "modules/india-post/templates/india-post-article-details-49.reference.xlsx");
const USER_REFERENCE = "C:/Users/LUMIN ADS/Documents/MF-DRAFT-20261114-21840020_fixed.xlsx";

async function headersOf(filePath: string) {
  const sheets = await readWorkbook(readFileSync(filePath));
  return { name: sheets[0]!.name, headers: sheets[0]!.rows[0]!, sheetCount: sheets.length };
}

describe("India Post 49-column ArticleDetails reference", () => {
  it("matches the official 49 headers, order, and worksheet name", async () => {
    const fixture = await headersOf(FIXTURE);
    expect(fixture.name).toBe("ArticleDetails");
    expect(fixture.headers).toHaveLength(49);
    expect(ARTICLE_DETAILS_HEADERS).toHaveLength(49);
    expect(ARTICLE_DETAILS_HEADERS.map((header) => header.trim())).toEqual(fixture.headers);
    expect(ARTICLE_DETAILS_HEADERS[18]).toBe("DECLARED VALUE");
    expect(ARTICLE_DETAILS_HEADERS[22]).toBe("LENGTH ");
    expect(ARTICLE_DETAILS_HEADERS[48]).toBe("SENDER ADD LINE 3");
  });

  it("matches the uploaded workbook when the file is present", async () => {
    if (!existsSync(USER_REFERENCE)) return;
    const uploaded = await headersOf(USER_REFERENCE);
    expect(uploaded.name).toBe("ArticleDetails");
    expect(uploaded.headers).toEqual(ARTICLE_DETAILS_HEADERS.map((header) => header.trim()));
  });

  it("reuses the same 49-column exporter for manifest email attachments", () => {
    const source = readFileSync(path.join(process.cwd(), "modules/manifest-email/deliver.ts"), "utf8");
    expect(source).toContain("exportManifestIndiaPostExcel");
    expect(source).toContain("loadExcel");
  });

  it("does not change the separate 26-column handover manifest", () => {
    expect(MANIFEST_EXPORT_HEADERS).toHaveLength(26);
    expect(MANIFEST_EXPORT_HEADERS).not.toContain("DECLARED VALUE");
    expect(MANIFEST_EXPORT_HEADERS[21]).toBe("Sender city");
  });

  it("fills merchant sender fields and keeps the booking office out of sender PIN", async () => {
    const identity = organizationLabelSender({
      name: "Kerlaz Stores",
      phone: "9876543210",
      line1: "NH 85",
      line2: "Near SO",
      city: "Kolenchery",
      state: "Kerala",
      pincode: "682311",
    });
    const draft = mapShipmentToArticle({
      serviceCode: "SP_INLAND_PARCEL",
      customerId: "1788590988",
      contractId: "41793509",
      barcode: "EB116121154IN",
      officeId: "21840020",
      originPin: "560078",
      weightGrams: 500,
      lengthCm: 18,
      widthCm: 10,
      heightCm: 10,
      senderName: identity.name,
      senderCompany: identity.company,
      senderLine1: identity.line1,
      senderLine2: identity.line2,
      senderCity: identity.city || "",
      senderState: identity.state,
      senderPin: identity.pincode || "",
      senderMobile: identity.phone || "",
      receiverName: "Aditha",
      receiverLine1: "OM SHAKTHI",
      receiverLine2: "KAILASH NAGAR",
      receiverCity: "Bangalore",
      receiverState: "Karnataka",
      receiverPin: "560062",
      receiverMobile: "9964903319",
      paymentMode: "COD",
      codAmount: 1199,
      strictDimensions: true,
    });
    const row = articleDetailsRow(draft, 1);
    expect(row).toHaveLength(49);
    const value = (header: (typeof ARTICLE_DETAILS_HEADERS)[number]) => row[ARTICLE_DETAILS_HEADERS.indexOf(header)];
    expect(value("SENDER NAME")).toBe("Kerlaz Stores");
    expect(value("SENDER COMPANY NAME")).toBe("Kerlaz Stores");
    expect(value("SENDER ADD LINE 1")).toBe("NH 85");
    expect(value("SENDER CITY")).toBe("Kolenchery");
    expect(value("SENDER STATE/UT")).toBe("Kerala");
    expect(value("SENDER PINCODE")).toBe("682311");
    expect(value("SENDER MOBILE NO")).toBe("9876543210");
    expect(value("RECEIVER NAME")).toBe("Aditha");
    expect(value("RECEIVER PINCODE")).toBe("560062");
    expect(value("BARCODE NO")).toBe("EB116121154IN");
    expect(value("PHYSICAL WEIGHT")).toBe(500);
    expect(value("LENGTH ")).toBe(18);
    expect(value("BREADTH/DIAMETER")).toBe(10);
    expect(value("HEIGHT")).toBe(10);
    expect(value("CODR/COD")).toBe("cod");
    expect(value("VALUE FOR CODR/COD")).toBe(1199);
    expect(value("DECLARED VALUE")).toBeNull();
    expect(value("SENDER PINCODE")).not.toBe("560078");

    const sheets = await articleDetailsWorkbook([row]).then((bytes) => readWorkbook(bytes));
    expect(sheets.map((sheet) => sheet.name)).toEqual(["ArticleDetails", "Information"]);
    expect(sheets[0]!.rows[0]).toEqual(ARTICLE_DETAILS_HEADERS.map((header) => header.trim()));
    expect(sheets[0]!.rows[1]).toHaveLength(49);
  });

  it("uses the selected pickup street instead of the default pickup", () => {
    const selected = organizationLabelSender(
      { name: "Kerlaz Stores", phone: "9876543210" },
      { id: "alt", name: "Alt warehouse", line1: "Bay 9", city: "Thrissur", state: "Kerala", pincode: "680001" }
    );
    const row = bookedShipmentRow(
      {
        id: "s1",
        order_id: "o1",
        barcode: "EB116121154IN",
        tracking_number: "EB116121154IN",
        service_code: "SP_INLAND_PARCEL",
        weight_grams: 200,
        length_cm: 18,
        width_cm: 10,
        height_cm: 10,
        payment_mode: "PREPAID",
        cod_amount: 0,
        booked_at: "2026-11-14T05:00:00Z",
        orders: { order_number: "PB-10027" },
        addresses: {
          name: "Aditha",
          line1: "OM SHAKTHI",
          city: "Bangalore",
          state: "Karnataka",
          pincode: "560062",
          phone: "9964903319",
        },
      },
      selected,
      selected.company,
      1
    );
    const value = (header: (typeof ARTICLE_DETAILS_HEADERS)[number]) => row[ARTICLE_DETAILS_HEADERS.indexOf(header)];
    expect(value("SENDER CITY")).toBe("Thrissur");
    expect(value("SENDER PINCODE")).toBe("680001");
    expect(value("SENDER ADD LINE 1")).toBe("Bay 9");
    expect(value("CODR/COD")).toBe("");
    expect(value("DECLARED VALUE")).toBeNull();
  });
});
