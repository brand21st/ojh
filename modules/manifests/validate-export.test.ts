import { describe, expect, it } from "vitest";
import { readWorkbook } from "@/lib/xlsx/read";
import { manifestCsv, manifestXlsx, MANIFEST_EXPORT_HEADERS } from "@/modules/manifests/export";
import { manifestTotals, type ManifestDetail, type ManifestLine } from "@/modules/manifests/service";
import { manifestExportErrorCount, validateManifestExport } from "@/modules/manifests/validate-export";

function line(overrides: Partial<ManifestLine> = {}): ManifestLine {
  return {
    shipmentId: crypto.randomUUID(),
    barcode: "EB116121154IN",
    orderNumber: "PB-10027",
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
    serviceLabel: "Speed Post Parcel Domestic",
    weightGrams: 100,
    paymentMode: "PREPAID",
    codAmount: 0,
    tariffAmount: 31,
    shipmentStatus: "MANIFEST_READY",
    addedAt: "2026-11-14T05:00:00Z",
    scanned: null,
    ...overrides,
  };
}

function detail(lines: ManifestLine[]): ManifestDetail {
  return {
    id: crypto.randomUUID(),
    name: "Draft",
    number: null,
    status: "DRAFT",
    date: "2026-11-14",
    officeId: "21840020",
    officeName: "J P Nagar Delivery Centre",
    shipmentCount: lines.length,
    createdAt: "2026-11-14T05:00:00Z",
    closedAt: null,
    reopenedAt: null,
    handedOverAt: null,
    handedOverTo: null,
    handoverNotes: null,
    hasProof: false,
    lines,
    totals: manifestTotals(lines),
    unscannedCount: 0,
  };
}

const sender = {
  name: "Kerlaz",
  company: "Kerlaz Stores",
  line1: "NH 85",
  city: "Bangalore",
  state: "Karnataka",
  pincode: "560078",
  phone: "8867969329",
};

describe("validateManifestExport", () => {
  it("accepts a 12-digit 91 prefix and a 10-digit number that starts with 91", () => {
    const issues = validateManifestExport(
      detail([line({ phone: "919632306200" }), line({ phone: "9108938854", barcode: "EB116121168IN" })]),
      sender
    );
    expect(issues.filter((item) => item.field === "Mobile")).toEqual([]);
  });

  it("errors on an invalid mobile, a bad PIN and a missing barcode", () => {
    const issues = validateManifestExport(
      detail([line({ phone: "12345", pincode: "56006", barcode: "  " })]),
      sender
    );
    expect(issues.filter((item) => item.severity === "error").map((item) => item.field)).toEqual([
      "Barcode",
      "Mobile",
      "Pincode",
    ]);
    expect(manifestExportErrorCount(issues)).toBe(3);
    expect(issues.find((item) => item.field === "Mobile")?.suggestion).toMatch(/12 digits/);
  });

  it("blocks handover export when sender city, PIN or mobile is invalid", () => {
    const issues = validateManifestExport(detail([line()]), {
      name: "Kerlaz",
      company: "Kerlaz Stores",
      line1: "NH 85",
      city: "",
      state: "Kerala",
      pincode: "68231",
      phone: "12345",
    });
    expect(issues.filter((item) => item.severity === "error").map((item) => item.field).sort()).toEqual([
      "Sender PIN",
      "Sender city",
      "Sender mobile",
    ]);
  });

  it("does not block handover when only API-only sender name, company or line 1 are missing", () => {
    const issues = validateManifestExport(detail([line()]), {
      name: "",
      company: "",
      line1: "",
      city: "Bangalore",
      state: "Karnataka",
      pincode: "560078",
      phone: "8867969329",
    });
    expect(manifestExportErrorCount(issues)).toBe(0);
    expect(issues.filter((item) => item.severity === "warning").map((item) => item.field)).toEqual([
      "Sender name",
      "Sender company",
      "Sender address",
    ]);
  });

  it("warns when tariff is missing or the address overflows, without blocking", () => {
    const issues = validateManifestExport(
      detail([line({ tariffAmount: null, line1: "A".repeat(250) })]),
      sender
    );
    expect(issues.map((item) => [item.field, item.severity])).toEqual([
      ["Tariff", "warning"],
      ["Address line 1", "warning"],
    ]);
    expect(manifestExportErrorCount(issues)).toBe(0);
  });
});

describe("handover export mobiles", () => {
  it("writes country-code mobiles as 10-digit text and keeps the sample totals", async () => {
    const lines: ManifestLine[] = [];
    for (let i = 0; i < 40; i += 1) {
      const cod = i < 6;
      lines.push(
        line({
          barcode: `EB11612${String(1154 + i).padStart(4, "0")}IN`,
          orderNumber: `PB-${10027 + i}`,
          phone: i < 13 ? "919632306200" : i < 15 ? "9108938854" : "9632306200",
          weightGrams: i < 20 ? 200 : 90,
          paymentMode: cod ? "COD" : "PREPAID",
          codAmount: cod ? [793, 326, 581, 496, 326, 326][i]! : 0,
          tariffAmount: 31,
        })
      );
    }
    expect(lines.reduce((sum, row) => sum + row.weightGrams, 0)).toBe(5800);
    expect(lines.filter((row) => row.paymentMode === "COD")).toHaveLength(6);
    expect(lines.reduce((sum, row) => sum + row.codAmount, 0)).toBe(2848);

    const manifest = detail(lines);
    const csv = manifestCsv(manifest, sender);
    expect(csv.split("\r\n")[0]?.replace(/^\uFEFF/, "").split(",")).toEqual([...MANIFEST_EXPORT_HEADERS]);
    expect(csv).toContain("9632306200");
    expect(csv).toContain("9108938854");
    expect(csv).not.toContain("919632306200");

    const sheets = await readWorkbook(await manifestXlsx(manifest, sender));
    expect(sheets[0]!.rows[0]).toEqual([...MANIFEST_EXPORT_HEADERS]);
    expect(sheets[0]!.rows).toHaveLength(41);
    expect(sheets[0]!.rows[1]![16]).toBe("9632306200");
    expect(sheets[0]!.rows[14]![16]).toBe("9108938854");
    expect(sheets[1]!.rows[4]).toEqual(["Articles", "40"]);
    expect(sheets[1]!.rows[5]).toEqual(["Total weight (g)", "5800"]);
    expect(sheets[1]!.rows[6]).toEqual(["COD articles", "6"]);
    expect(sheets[1]!.rows[7]).toEqual(["COD amount", "2848"]);
  });
});
