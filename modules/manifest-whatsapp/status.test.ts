import { describe, expect, it } from "vitest";
import { applyWhatsAppProviderStatus, canAdvanceWhatsAppStatus } from "@/modules/manifest-whatsapp/status";

describe("manifest WhatsApp status", () => {
  it("maps provider events without inventing extras", () => {
    expect(applyWhatsAppProviderStatus("SENT", "delivered")).toBe("DELIVERED");
    expect(applyWhatsAppProviderStatus("ACCEPTED", "sent")).toBe("SENT");
    expect(applyWhatsAppProviderStatus("ACCEPTED", "failed")).toBe("FAILED");
    expect(applyWhatsAppProviderStatus("QUEUED", "read")).toBe("DELIVERED");
  });

  it("does not regress a later status", () => {
    expect(canAdvanceWhatsAppStatus("DELIVERED", "SENT")).toBe(false);
    expect(canAdvanceWhatsAppStatus("FAILED", "SENT")).toBe(false);
    expect(canAdvanceWhatsAppStatus("ACCEPTED", "SENT")).toBe(true);
    expect(canAdvanceWhatsAppStatus("UNKNOWN", "DELIVERED")).toBe(true);
  });
});
