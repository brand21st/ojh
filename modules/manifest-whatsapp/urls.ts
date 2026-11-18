const SIGNED_QUERY = /([?&](?:token|Signature|X-Amz-Signature|sig)=)[^&\s]+/gi;

export function redactSignedUrl(value: string) {
  return value.replace(SIGNED_QUERY, "$1[redacted]");
}

export function sanitizeWhatsAppError(error: unknown) {
  const raw = error instanceof Error ? error.message : "WhatsApp delivery failed.";
  return redactSignedUrl(raw).replace(/[\r\n]+/g, " ").slice(0, 300);
}
