import { describe, expect, it } from "vitest";
import {
  invoiceBulkDownloadMessage,
  mergeSelectedRows,
  partitionInvoiceDownloads,
  uniqueDownloadNames,
} from "@/lib/invoices/bulk-download";
import { shippingInvoiceFilename, shippingInvoiceHasPdf } from "@/lib/invoices/labels";

describe("invoice bulk download", () => {
  it("keeps unique PDF names when invoice numbers collide", () => {
    expect(uniqueDownloadNames(["INV-1.pdf", "INV-1.pdf", "INV-2"])).toEqual(["INV-1.pdf", "INV-1-2.pdf", "INV-2.pdf"]);
  });

  it("keeps selected rows from other pages when the visible list changes", () => {
    const previous = [{ id: "a", status: "ISSUED" }, { id: "b", status: "DRAFT" }];
    const visible = [{ id: "c", status: "ISSUED" }];
    expect(mergeSelectedRows(previous, visible, ["a", "c"])).toEqual([
      { id: "a", status: "ISSUED" },
      { id: "c", status: "ISSUED" },
    ]);
  });

  it("skips shipping documents that are still generating", () => {
    const { items, skipped } = partitionInvoiceDownloads(
      [
        { id: "ready", status: "GENERATED", invoiceNumber: "SH-1" },
        { id: "wait", status: "PENDING", invoiceNumber: "SH-2" },
      ],
      (row) => shippingInvoiceHasPdf(row.status),
      (row) => shippingInvoiceFilename(row.invoiceNumber, row.id),
      "shipping"
    );
    expect(skipped).toBe(1);
    expect(items).toEqual([{ id: "ready", filename: "SH-1.pdf", kind: "shipping" }]);
  });

  it("explains skipped and failed downloads", () => {
    expect(invoiceBulkDownloadMessage(0, 2, 0)).toBe("None of the selected invoices have a PDF yet.");
    expect(invoiceBulkDownloadMessage(2, 1, 1)).toBe(
      "Saved 2 PDFs. 1 was skipped because it has no PDF yet. 1 could not be downloaded."
    );
    expect(invoiceBulkDownloadMessage(4, 0, 0, "pdf")).toBe("Saved 1 PDF with 4 invoices.");
  });
});
