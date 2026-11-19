import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { OTP_MESSAGES } from "@/lib/auth/otp/policy";
import { getPlatformVachatConfig, isPlatformVachatActive } from "@/modules/vachat/platform-config";
import { sendVachatAuthenticationTemplate } from "@/modules/vachat/send";

/** The OTP template set in Super Admin (or the env fallback), when platform VaChat can send it. */
export async function whatsappOtpTemplate() {
  const config = await getPlatformVachatConfig();
  if (!isPlatformVachatActive(config) || !config.otpTemplateName) return null;
  return { name: config.otpTemplateName, language: config.otpTemplateLanguage };
}

export async function sendWhatsappOtp(phone: string, otp: string) {
  const template = await whatsappOtpTemplate();
  if (!template) {
    throw new AppError(ERROR_CODES.PROVIDER_ERROR, OTP_MESSAGES.sendFailed);
  }
  return sendVachatAuthenticationTemplate({
    to: phone,
    templateName: template.name,
    language: template.language,
    otp,
  });
}
