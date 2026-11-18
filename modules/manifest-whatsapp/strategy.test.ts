import { describe, expect, it } from "vitest";
import { chooseManifestWhatsAppSendMode } from "@/modules/manifest-whatsapp/strategy";

describe("manifest WhatsApp send mode", () => {
  it("blocks free-form documents when the window is unknown and no template is configured", () => {
    expect(
      chooseManifestWhatsAppSendMode({
        sessionDocumentsEnabled: false,
        templateName: "",
        windowOpen: null,
      })
    ).toEqual({ mode: "blocked", code: "TEMPLATE_REQUIRED" });
  });

  it("uses a template link when the window cannot be confirmed", () => {
    expect(
      chooseManifestWhatsAppSendMode({
        sessionDocumentsEnabled: false,
        templateName: "manifest_excel_link",
        windowOpen: null,
      })
    ).toEqual({ mode: "template_link", templateName: "manifest_excel_link" });
  });

  it("sends a session document only when explicitly enabled", () => {
    expect(
      chooseManifestWhatsAppSendMode({
        sessionDocumentsEnabled: true,
        templateName: "manifest_excel_link",
        windowOpen: null,
      })
    ).toEqual({ mode: "document" });
  });
});
