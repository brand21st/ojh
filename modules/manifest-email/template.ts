export const MANIFEST_EMAIL_TEMPLATE_VERSION = "manifest-email-v1";

export type ManifestEmailContent = {
  merchantName: string;
  merchantEmail?: string;
  merchantPhone?: string;
  manifestNumber: string;
  manifestDate: string;
  shipmentCount: number;
  officeName: string;
};

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function plainText(value: string) {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export function formatManifestDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return plainText(value) || "—";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function renderManifestEmail(content: ManifestEmailContent) {
  const merchant = plainText(content.merchantName) || "Merchant";
  const email = plainText(content.merchantEmail ?? "") || "—";
  const phone = plainText(content.merchantPhone ?? "") || "—";
  const number = plainText(content.manifestNumber) || "Manifest";
  const date = formatManifestDate(content.manifestDate);
  const office = plainText(content.officeName) || "Not specified";
  const count = Number.isFinite(content.shipmentCount) ? Math.max(0, Math.floor(content.shipmentCount)) : 0;
  const subject = `India Post Shipment Manifest | ${merchant} | ${number} | ${date}`.slice(0, 180);

  const text = [
    "Dear India Post Team,",
    "",
    `Please find attached the shipment manifest submitted by ${merchant} for processing at your booking office.`,
    "",
    "Manifest Details",
    `Merchant Name: ${merchant}`,
    `Merchant Email: ${email}`,
    `Merchant Phone: ${phone}`,
    `Manifest Number: ${number}`,
    `Manifest Date: ${date}`,
    `Total Shipments: ${count}`,
    `Booking Office: ${office}`,
    "",
    "The attached Excel file contains the shipment details in the India Post ArticleDetails format.",
    "",
    "Kindly review the attached manifest and proceed with the applicable booking office procedures.",
    "",
    "For any clarification regarding the shipments, please contact the merchant using the authorized contact information provided.",
    "",
    "Thank you for your assistance.",
    "",
    "Best regards,",
    merchant,
    email === "—" ? null : email,
    phone === "—" ? null : phone,
    "Shipment Management via PostBus",
    "",
    "Powered by PostBus",
    "www.postbus.in",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const merchantHtml = escapeHtml(merchant);
  const emailHtml = escapeHtml(email);
  const phoneHtml = escapeHtml(phone);
  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#ffffff;color:#18181b;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
          <tr>
            <td style="padding:0 0 16px;border-bottom:3px solid #e11d48;">
              <p style="margin:0;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#e11d48;font-weight:700;">PostBus</p>
              <h1 style="margin:8px 0 0;font-size:22px;line-height:1.3;color:#18181b;">India Post shipment manifest</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 0;font-size:15px;line-height:1.5;">
              <p style="margin:0 0 12px;">Dear India Post Team,</p>
              <p style="margin:0 0 16px;">Please find attached the shipment manifest submitted by <strong>${merchantHtml}</strong> for processing at your booking office.</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e4e7;border-radius:8px;">
                <tr><td style="padding:12px 16px;font-size:13px;color:#71717a;">Merchant Name</td><td style="padding:12px 16px;font-size:14px;">${merchantHtml}</td></tr>
                <tr><td style="padding:12px 16px;font-size:13px;color:#71717a;border-top:1px solid #e4e4e7;">Merchant Email</td><td style="padding:12px 16px;font-size:14px;border-top:1px solid #e4e4e7;">${emailHtml}</td></tr>
                <tr><td style="padding:12px 16px;font-size:13px;color:#71717a;border-top:1px solid #e4e4e7;">Merchant Phone</td><td style="padding:12px 16px;font-size:14px;border-top:1px solid #e4e4e7;">${phoneHtml}</td></tr>
                <tr><td style="padding:12px 16px;font-size:13px;color:#71717a;border-top:1px solid #e4e4e7;">Manifest Number</td><td style="padding:12px 16px;font-size:14px;border-top:1px solid #e4e4e7;">${escapeHtml(number)}</td></tr>
                <tr><td style="padding:12px 16px;font-size:13px;color:#71717a;border-top:1px solid #e4e4e7;">Manifest Date</td><td style="padding:12px 16px;font-size:14px;border-top:1px solid #e4e4e7;">${escapeHtml(date)}</td></tr>
                <tr><td style="padding:12px 16px;font-size:13px;color:#71717a;border-top:1px solid #e4e4e7;">Total Shipments</td><td style="padding:12px 16px;font-size:14px;border-top:1px solid #e4e4e7;">${count}</td></tr>
                <tr><td style="padding:12px 16px;font-size:13px;color:#71717a;border-top:1px solid #e4e4e7;">Booking Office</td><td style="padding:12px 16px;font-size:14px;border-top:1px solid #e4e4e7;">${escapeHtml(office)}</td></tr>
              </table>
              <p style="margin:16px 0 0;">The attached Excel file contains the shipment details in the India Post ArticleDetails format.</p>
              <p style="margin:12px 0 0;">Kindly review the attached manifest and proceed with the applicable booking office procedures.</p>
              <p style="margin:12px 0 0;">For any clarification regarding the shipments, please contact the merchant using the authorized contact information provided.</p>
              <p style="margin:16px 0 0;">Thank you for your assistance.</p>
              <p style="margin:16px 0 0;">Best regards,<br><strong>${merchantHtml}</strong>${email === "—" ? "" : `<br>${emailHtml}`}${phone === "—" ? "" : `<br>${phoneHtml}`}<br>Shipment Management via <strong>PostBus</strong></p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 0 0;border-top:1px solid #e4e4e7;font-size:12px;line-height:1.5;color:#71717a;">
              Powered by PostBus<br>
              <a href="https://www.postbus.in" style="color:#e11d48;text-decoration:none;">www.postbus.in</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
