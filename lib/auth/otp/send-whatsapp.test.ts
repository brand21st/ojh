import { beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ value: { enabled: true, apiKey: "k", otpTemplateName: "", otpTemplateLanguage: "en" } }));
const send = vi.hoisted(() => vi.fn(async () => ({ sent: true as const, messageId: "m1" })));

vi.mock("@/modules/vachat/platform-config", () => ({
  getPlatformVachatConfig: async () => config.value,
  isPlatformVachatActive: (value: { enabled: boolean; apiKey: string }) => Boolean(value.enabled && value.apiKey),
}));
vi.mock("@/modules/vachat/send", () => ({ sendVachatAuthenticationTemplate: send }));

import { sendWhatsappOtp, whatsappOtpTemplate } from "@/lib/auth/otp/send-whatsapp";

describe("WhatsApp OTP template", () => {
  beforeEach(() => send.mockClear());

  it("is unavailable until an OTP template is chosen", async () => {
    config.value = { enabled: true, apiKey: "k", otpTemplateName: "", otpTemplateLanguage: "en" };
    expect(await whatsappOtpTemplate()).toBeNull();
    await expect(sendWhatsappOtp("+919876543210", "123456")).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("is unavailable while platform VaChat is off", async () => {
    config.value = { enabled: false, apiKey: "k", otpTemplateName: "postbus_otp", otpTemplateLanguage: "en" };
    expect(await whatsappOtpTemplate()).toBeNull();
  });

  it("sends the code through the saved template and language", async () => {
    config.value = { enabled: true, apiKey: "k", otpTemplateName: "postbus_otp", otpTemplateLanguage: "en_US" };
    await sendWhatsappOtp("+919876543210", "123456");
    expect(send).toHaveBeenCalledWith({ to: "+919876543210", templateName: "postbus_otp", language: "en_US", otp: "123456" });
  });
});
