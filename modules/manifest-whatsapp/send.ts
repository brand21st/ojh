import { vachatHeaders } from "@/modules/vachat/service";
import { sanitizeWhatsAppError } from "@/modules/manifest-whatsapp/urls";

export type ManifestWhatsAppSendInput = {
  apiBaseUrl: string;
  apiKey: string;
  to: string;
  filename: string;
  caption: string;
  mediaUrl: string;
  mode: "document" | "template_link";
  templateName?: string;
  templateLanguage?: string;
  bodyParams?: string[];
};

export type ManifestWhatsAppSendResult = {
  messageId: string | null;
  whatsappMessageId: string | null;
};

export async function sendManifestWhatsAppDocument(
  input: ManifestWhatsAppSendInput
): Promise<ManifestWhatsAppSendResult> {
  const baseUrl = input.apiBaseUrl.replace(/\/$/, "");
  const body =
    input.mode === "document"
      ? {
          to: input.to,
          type: "document",
          media_url: input.mediaUrl,
          filename: input.filename,
          text: input.caption,
        }
      : {
          to: input.to,
          type: "template",
          template: {
            name: input.templateName,
            language: input.templateLanguage || "en",
            params: {
              body: input.bodyParams ?? [],
              buttonParams: { 0: input.mediaUrl },
            },
          },
        };

  const res = await fetch(`${baseUrl}/api/v1/messages`, {
    method: "POST",
    headers: vachatHeaders(input.apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = (await res.json().catch(() => null)) as {
    data?: { message_id?: string; whatsapp_message_id?: string };
    error?: { code?: string; message?: string };
  } | null;
  if (!res.ok) {
    const message = sanitizeWhatsAppError(json?.error?.message || `Vachat document send failed (${res.status})`);
    const err = new Error(message) as Error & { status: number; code: string };
    err.status = res.status;
    err.code = json?.error?.code || `HTTP_${res.status}`;
    throw err;
  }
  return {
    messageId: json?.data?.message_id ?? null,
    whatsappMessageId: json?.data?.whatsapp_message_id ?? null,
  };
}
