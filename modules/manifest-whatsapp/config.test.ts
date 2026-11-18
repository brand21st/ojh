import { afterEach, describe, expect, it, vi } from "vitest";
import { manifestWhatsAppEnabled, manifestWhatsAppSessionDocumentsEnabled } from "@/modules/manifest-whatsapp/config";

describe("manifest WhatsApp kill switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stays off unless the env flag is exactly true", () => {
    vi.stubEnv("MANIFEST_WHATSAPP_ENABLED", "false");
    vi.stubEnv("MANIFEST_WHATSAPP_SESSION_DOCUMENTS", "");
    expect(manifestWhatsAppEnabled()).toBe(false);
    expect(manifestWhatsAppSessionDocumentsEnabled()).toBe(false);
  });

  it("turns on only for the exact string true", () => {
    vi.stubEnv("MANIFEST_WHATSAPP_ENABLED", "true");
    vi.stubEnv("MANIFEST_WHATSAPP_SESSION_DOCUMENTS", "true");
    expect(manifestWhatsAppEnabled()).toBe(true);
    expect(manifestWhatsAppSessionDocumentsEnabled()).toBe(true);
  });
});
