import { describe, expect, it } from "vitest";
import { indiaPostExcelFilename } from "@/modules/manifests/india-post-excel";
import { escapeHtml, renderManifestEmail } from "@/modules/manifest-email/template";

describe("manifest email template", () => {
  it("escapes merchant-controlled text and names the manifest", () => {
    const merchant = `Asha <script>alert("x")</script> & Co`;
    const rendered = renderManifestEmail({
      merchantName: merchant,
      merchantEmail: `hello+"<script>"@store.example`,
      merchantPhone: "98765 43210\n<script>",
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
    expect(rendered.text).toContain("Merchant Email: hello+\"<script>\"@store.example");
    expect(rendered.text).toContain("Merchant Phone: 98765 43210 <script>");
    expect(rendered.html).toContain("Merchant Email");
    expect(rendered.html).toContain("Merchant Phone");
    expect(rendered.html).toContain(escapeHtml(`hello+"<script>"@store.example`));
    expect(rendered.html).toContain(escapeHtml("98765 43210 <script>"));
    expect(rendered.text).not.toContain("Booking office address");
    expect(rendered.html).not.toContain("Booking office address");
    expect(rendered.text.toLowerCase()).not.toContain("has booked");
    expect(rendered.text.toLowerCase()).not.toContain("physically received");
    expect(rendered.html).toContain("www.postbus.in");
  });

  it("shows a dash when merchant email or phone is missing", () => {
    const rendered = renderManifestEmail({
      merchantName: "Kerlaz Stores",
      merchantEmail: "  ",
      merchantPhone: "",
      manifestNumber: "MF-1",
      manifestDate: "2026-11-15",
      shipmentCount: 1,
      officeName: "Tirur HO",
    });
    expect(rendered.text).toContain("Merchant Email: —");
    expect(rendered.text).toContain("Merchant Phone: —");
  });

  it("adds the booking office address when one is known", () => {
    const rendered = renderManifestEmail({
      merchantName: "Asha",
      merchantEmail: "store@example.com",
      merchantPhone: "9876543210",
      manifestNumber: "MF-1",
      manifestDate: "2026-11-15",
      shipmentCount: 1,
      officeName: "Ernakulam HO",
      officeAddress: `Kochi, Kerala <script>682001`,
    });
    expect(rendered.text).toContain("Booking office address: Kochi, Kerala <script>682001");
    expect(rendered.html).toContain("Kochi, Kerala &lt;script&gt;682001");
    expect(rendered.html).not.toContain("<script>682001");
  });

  it("uses the existing India Post Excel filename", () => {
    expect(
      indiaPostExcelFilename({ number: "MF-20261115-001", date: "2026-11-15", officeId: "22660454" })
    ).toBe("manifest_MF-20261115-001_india_post.xlsx");
  });
});
