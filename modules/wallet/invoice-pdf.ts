import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { canonicalStateName } from "@/modules/ai-accountant/gst";

/** Everything printed on a wallet recharge tax invoice, read from the issued row. */
export type WalletInvoicePdfInput = {
  invoiceNumber: string;
  issuedAt: string;
  paidAt: string | null;
  supplierLegalName: string;
  supplierAddress: string;
  supplierGstin: string;
  customerLegalName: string;
  customerAddress: string;
  customerGstin: string;
  placeOfSupply: "INTRA" | "INTER";
  supplierStateCode: string | null;
  customerStateCode: string | null;
  sac: string;
  description: string;
  gstRateBps: number;
  grossPaise: bigint;
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  totalTaxPaise: bigint;
  paymentReference: string | null;
  refundedPaise: bigint;
};

const INK = rgb(0.035, 0.035, 0.043);
const MUTED = rgb(0.443, 0.443, 0.478);
const LINE = rgb(0.898, 0.906, 0.922);
const BRAND = rgb(0.882, 0.114, 0.282);

/** Standard PDF fonts cannot draw the rupee sign, so amounts print as "Rs." like subscription invoices. */
export function invoiceRupees(paise: bigint) {
  const negative = paise < BigInt(0);
  const abs = negative ? -paise : paise;
  const whole = (abs / BigInt(100)).toString();
  const grouped = whole.length > 3 ? `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${whole.slice(-3)}` : whole;
  return `${negative ? "-" : ""}Rs. ${grouped}.${(abs % BigInt(100)).toString().padStart(2, "0")}`;
}

function percent(bps: number) {
  return `${(bps / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
}

function stateLabel(code: string | null) {
  if (!code) return null;
  const name = canonicalStateName(code);
  return name ? `${code} - ${name}` : code;
}

function istDate(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
}

/** Strips characters the standard fonts cannot encode, so one odd name never breaks the PDF. */
function printable(text: string) {
  return text.replace(/₹/g, "Rs.").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

function wrap(text: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = [];
  for (const paragraph of printable(text).split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [""];
}

export async function renderWalletInvoicePdf(input: WalletInvoicePdfInput) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Tax invoice ${input.invoiceNumber}`);
  doc.setAuthor(printable(input.supplierLegalName));
  const page: PDFPage = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const left = 48;
  const right = 595.28 - 48;

  const text = (value: string, x: number, y: number, size = 10, strong = false, color = INK) =>
    page.drawText(printable(value), { x, y, size, font: strong ? bold : font, color });
  const textRight = (value: string, x: number, y: number, size = 10, strong = false, color = INK) => {
    const f = strong ? bold : font;
    page.drawText(printable(value), { x: x - f.widthOfTextAtSize(printable(value), size), y, size, font: f, color });
  };
  const rule = (y: number) => page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.8, color: LINE });

  let y = 790;
  text("POSTBUS", left, y, 18, true, BRAND);
  textRight("TAX INVOICE", right, y + 2, 16, true);
  y -= 22;
  textRight(`Invoice no. ${input.invoiceNumber}`, right, y, 10, true);
  y -= 14;
  textRight(`Invoice date ${istDate(input.issuedAt)}`, right, y, 10, false, MUTED);
  y -= 14;
  textRight(`Payment date ${istDate(input.paidAt)}`, right, y, 10, false, MUTED);
  y -= 22;
  rule(y);
  y -= 22;

  const colWidth = (right - left - 24) / 2;
  const block = (title: string, lines: string[], x: number, startY: number) => {
    let cy = startY;
    text(title, x, cy, 9, true, MUTED);
    cy -= 15;
    for (const [index, line] of lines.entries()) {
      for (const part of wrap(line, index === 0 ? bold : font, 10, colWidth)) {
        text(part, x, cy, 10, index === 0);
        cy -= 13;
      }
    }
    return cy;
  };
  const supplierEnd = block(
    "FROM",
    [input.supplierLegalName, input.supplierAddress, `GSTIN: ${input.supplierGstin}`],
    left,
    y
  );
  const customerLines = [input.customerLegalName];
  if (input.customerAddress) customerLines.push(input.customerAddress);
  customerLines.push(input.customerGstin ? `GSTIN: ${input.customerGstin}` : "Unregistered (no GSTIN)");
  const customerEnd = block("BILL TO", customerLines, left + colWidth + 24, y);
  y = Math.min(supplierEnd, customerEnd) - 8;

  const pos =
    input.placeOfSupply === "INTER"
      ? stateLabel(input.customerStateCode) ?? "Other state (IGST)"
      : stateLabel(input.supplierStateCode ?? input.customerStateCode) ?? "Same state (CGST + SGST)";
  text(`Place of supply: ${pos}`, left, y, 10);
  y -= 14;
  text("Tax payable on reverse charge: No", left, y, 10);
  y -= 24;

  // Line item
  page.drawRectangle({ x: left, y: y - 6, width: right - left, height: 22, color: rgb(0.98, 0.98, 0.98) });
  text("Description", left + 8, y, 9, true, MUTED);
  text("SAC", left + 300, y, 9, true, MUTED);
  textRight("Taxable value", right - 8, y, 9, true, MUTED);
  y -= 26;
  text(input.description, left + 8, y, 10);
  text(input.sac || "-", left + 300, y, 10);
  textRight(invoiceRupees(input.taxablePaise), right - 8, y, 10);
  y -= 12;
  rule(y);
  y -= 22;

  const row = (label: string, value: string, strong = false) => {
    text(label, left + 300, y, 10, strong, strong ? INK : MUTED);
    textRight(value, right - 8, y, 10, strong);
    y -= 16;
  };
  row("Taxable value", invoiceRupees(input.taxablePaise));
  if (input.placeOfSupply === "INTER") {
    row(`IGST @ ${percent(input.gstRateBps)}`, invoiceRupees(input.igstPaise));
  } else {
    row(`CGST @ ${percent(input.gstRateBps / 2)}`, invoiceRupees(input.cgstPaise));
    row(`SGST @ ${percent(input.gstRateBps / 2)}`, invoiceRupees(input.sgstPaise));
  }
  row("Total GST", invoiceRupees(input.totalTaxPaise));
  y -= 2;
  page.drawLine({ start: { x: left + 300, y: y + 10 }, end: { x: right, y: y + 10 }, thickness: 0.8, color: LINE });
  y -= 4;
  row("Invoice total", invoiceRupees(input.grossPaise), true);
  y -= 10;

  text(`Amount paid: ${invoiceRupees(input.grossPaise)}`, left, y, 10);
  y -= 14;
  text(`Payment reference: ${input.paymentReference ?? "-"}`, left, y, 10, false, MUTED);
  y -= 14;
  text(`Wallet credit: ${invoiceRupees(input.taxablePaise)} (taxable value; GST is not credited)`, left, y, 10, false, MUTED);
  if (input.refundedPaise > BigInt(0)) {
    y -= 14;
    text(`Refunded later: ${invoiceRupees(input.refundedPaise)}. A refund does not change this invoice.`, left, y, 10, false, MUTED);
  }

  text(`Computer-generated invoice. ${input.supplierLegalName}`, left, 60, 8, false, MUTED);
  return doc.save();
}
