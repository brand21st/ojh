import { createTransport } from "nodemailer";
import { manifestEmailEnabled, manifestSmtpConfig } from "@/modules/manifest-email/config";

export type OutboundManifestMail = {
  to: string[];
  cc: string[];
  replyTo: string | null;
  subject: string;
  text: string;
  html: string;
  filename: string;
  content: Buffer;
};

export type MailAccepted = {
  messageId: string;
  response: string;
};

export type SmtpFailureKind = "retry" | "permanent" | "unknown";

export type SmtpFailure = {
  kind: SmtpFailureKind;
  code: string;
  message: string;
};

export type SmtpTransport = {
  sendMail: (message: Record<string, unknown>) => Promise<{ messageId?: string; response?: string }>;
};

export function formatMailbox(name: string, email: string) {
  const safe = name.replace(/[\r\n<>"]/g, "").trim() || "PostBus Manifest Service";
  return `${safe} <${email}>`;
}

export function sanitizeMailError(error: unknown) {
  const raw = error instanceof Error ? error.message : "The mail server could not accept this message.";
  const password = manifestSmtpConfig().password;
  const cleaned = password ? raw.split(password).join("[redacted]") : raw;
  return cleaned.replace(/[\r\n]+/g, " ").slice(0, 300);
}

const RETRYABLE_SMTP = new Set([421, 450, 451, 452]);
const CONNECT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const AMBIGUOUS_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ESOCKET", "ECONNECTION"]);

export function classifySmtpFailure(error: unknown, phase: "CONNECTING" | "SUBMITTED"): SmtpFailure {
  const record = error as { code?: string; responseCode?: number; message?: string };
  const code = typeof record?.code === "string" && record.code.trim() ? record.code.trim() : "SMTP_ERROR";
  const message = sanitizeMailError(error);
  const responseCode = typeof record?.responseCode === "number" ? record.responseCode : undefined;

  if (code === "SMTP_NOT_CONFIGURED" || code === "MANIFEST_EMAIL_DISABLED") {
    return { kind: "permanent", code, message };
  }
  if (responseCode !== undefined && responseCode >= 500) {
    return { kind: "permanent", code: `SMTP_${responseCode}`, message };
  }
  if (responseCode !== undefined && responseCode >= 400) {
    return RETRYABLE_SMTP.has(responseCode)
      ? { kind: "retry", code: `SMTP_${responseCode}`, message }
      : { kind: "permanent", code: `SMTP_${responseCode}`, message };
  }
  if (CONNECT_CODES.has(code)) return { kind: "retry", code, message };
  if (phase === "SUBMITTED" && AMBIGUOUS_CODES.has(code)) {
    return { kind: "unknown", code, message };
  }
  if (AMBIGUOUS_CODES.has(code)) return { kind: "retry", code, message };
  return { kind: "retry", code, message: message || "The mail server is temporarily unavailable." };
}

export function createManifestMailTransport(): SmtpTransport {
  const smtp = manifestSmtpConfig();
  return createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  }) as SmtpTransport;
}

export async function sendManifestMail(
  mail: OutboundManifestMail,
  transport?: SmtpTransport
): Promise<MailAccepted> {
  if (!manifestEmailEnabled()) {
    throw Object.assign(new Error("Manifest email is turned off on this server."), { code: "MANIFEST_EMAIL_DISABLED" });
  }
  const smtp = manifestSmtpConfig();
  if (!smtp.host || !smtp.fromEmail) {
    throw Object.assign(new Error("The mail server is not configured."), { code: "SMTP_NOT_CONFIGURED" });
  }
  const info = await (transport ?? createManifestMailTransport()).sendMail({
    from: formatMailbox(smtp.fromName, smtp.fromEmail),
    to: mail.to,
    cc: mail.cc.length ? mail.cc : undefined,
    replyTo: mail.replyTo || undefined,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    attachments: [
      {
        filename: mail.filename,
        content: mail.content,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ],
  });
  return {
    messageId: String(info.messageId ?? "").slice(0, 200),
    response: sanitizeMailError(info.response || "250 accepted"),
  };
}
