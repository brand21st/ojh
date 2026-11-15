import { describe, expect, it } from "vitest";
import { indiaPostExcelFilename } from "@/modules/manifests/india-post-excel";
import { escapeHtml, renderManifestEmail } from "@/modules/manifest-email/template";

describe("manifest email template", () => {
  it("escapes merchant-controlled text and names the manifest", () => {
    const merchant = `Asha <script>alert("x")</script> & Co`;
    const rendered = renderManifestEmail({
      merchantName: merchant,
      manifestNumber: "MF-20261115-001",
      manifestDate: "2026-11-15",
      shipmentCount: 118,
      officeName: "Kolenchery SO",
    });
    expect(rendered.subject).toBe("India Post Shipment Manifest | Asha <script>alert(\"x\")</script> & Co | MF-20261115-001 | 15 Nov 2026");
    expect(rendered.html).toContain(escapeHtml(merchant));
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.text).toContain("submitted by");
    expect(rendered.text).toContain("MF-20261115-001");
    expect(rendered.text).toContain("118");
    expect(rendered.text).toContain("Kolenchery SO");
    expect(rendered.text.toLowerCase()).not.toContain("has booked");
    expect(rendered.text.toLowerCase()).not.toContain("physically received");
    expect(rendered.html).toContain("www.postbus.in");
  });

  it("uses the existing India Post Excel filename", () => {
    expect(
      indiaPostExcelFilename({ number: "MF-20261115-001", date: "2026-11-15", officeId: "22660454" })
    ).toBe("manifest_MF-20261115-001_india_post.xlsx");
  });
});
