export type ManifestWhatsAppSendMode =
  | { mode: "document" }
  | { mode: "template_link"; templateName: string }
  | { mode: "blocked"; code: "TEMPLATE_REQUIRED" };

export function chooseManifestWhatsAppSendMode(input: {
  sessionDocumentsEnabled: boolean;
  templateName: string;
  windowOpen: boolean | null;
}): ManifestWhatsAppSendMode {
  if (input.sessionDocumentsEnabled) return { mode: "document" };
  const templateName = input.templateName.trim();
  if (templateName) return { mode: "template_link", templateName };
  return { mode: "blocked", code: "TEMPLATE_REQUIRED" };
}
