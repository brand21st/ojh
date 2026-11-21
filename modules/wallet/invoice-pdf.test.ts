import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { invoiceRupees, renderWalletInvoicePdf, type WalletInvoicePdfInput } from "@/modules/wallet/invoice-pdf";

const base: WalletInvoicePdfInput = {
  invoiceNumber: "PB/2026-27/000042",
  issuedAt: "2026-11-21T06:00:00Z",
  paidAt: "2026-11-21T05:59:00Z",
  supplierLegalName: "PostBus Technologies Pvt Ltd",
  supplierAddress: "12 MG Road, Bengaluru 560001",
  supplierGstin: "29AAACP1234A1Z5",
  customerLegalName: "Merchant",
  customerAddress: "",
  customerGstin: "",
  placeOfSupply: "INTRA",
  supplierStateCode: "29",
  customerStateCode: null,
  sac: "",
  description: "PostBus prepaid wallet recharge",
  gstRateBps: 1800,
  grossPaise: BigInt(100000),
  taxablePaise: BigInt(84746),
  cgstPaise: BigInt(7627),
  sgstPaise: BigInt(7627),
  igstPaise: BigInt(0),
  totalTaxPaise: BigInt(15254),
  paymentReference: "pay_1",
  refundedPaise: BigInt(0),
};

describe("wallet invoice PDF", () => {
  it("formats amounts with Indian grouping and no rupee glyph", () => {
    expect(invoiceRupees(BigInt(84746))).toBe("Rs. 847.46");
    expect(invoiceRupees(BigInt(1234567890))).toBe("Rs. 1,23,45,678.90");
    expect(invoiceRupees(BigInt(5))).toBe("Rs. 0.05");
  });

  it("renders one page for intra-state, inter-state and non-Latin names", async () => {
    const cases: WalletInvoicePdfInput[] = [
      base,
      {
        ...base,
        placeOfSupply: "INTER",
        customerStateCode: "27",
        igstPaise: BigInt(15254),
        cgstPaise: BigInt(0),
        sgstPaise: BigInt(0),
        customerGstin: "27ABCDE1234F1Z5",
        customerAddress: "Pune",
      },
      { ...base, customerLegalName: "मेरी दुकान ₹ Store", refundedPaise: BigInt(5000), sac: "998599" },
    ];
    for (const input of cases) {
      const bytes = await renderWalletInvoicePdf(input);
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBe(1);
      expect(doc.getTitle()).toBe(`Tax invoice ${input.invoiceNumber}`);
    }
  });
});
