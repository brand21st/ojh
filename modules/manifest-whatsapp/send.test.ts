import { describe, expect, it, vi } from "vitest";
import { sendManifestWhatsAppDocument } from "@/modules/manifest-whatsapp/send";

describe("manifest WhatsApp send contract", () => {
  it("posts a document payload to Vachat messages", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { message_id: "vac-1", whatsapp_message_id: "wamid.1" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendManifestWhatsAppDocument({
      apiBaseUrl: "https://cloud.vachat.in",
      apiKey: "wacrm_test",
      to: "+919876543210",
      filename: "india_post_manifest.xlsx",
      caption: "India Post Booking Manifest",
      mediaUrl: "https://example.com/manifest.xlsx",
      mode: "document",
    });
    expect(result).toEqual({ messageId: "vac-1", whatsappMessageId: "wamid.1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.vachat.in/api/v1/messages",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toMatchObject({
      to: "+919876543210",
      type: "document",
      media_url: "https://example.com/manifest.xlsx",
      filename: "india_post_manifest.xlsx",
    });
    vi.unstubAllGlobals();
  });
});
