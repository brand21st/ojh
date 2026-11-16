import { uniqueDownloadNames } from "@/lib/invoices/bulk-download";

export async function fetchInvoicePdfBlob(invoiceId: string, kind: "shipping" | "sales" = "shipping") {
  const path = kind === "sales" ? `/api/v1/sales-invoices/${invoiceId}/download` : `/api/v1/invoices/${invoiceId}/download`;
  const response = await fetch(path, { credentials: "same-origin" });
  const type = response.headers.get("Content-Type") ?? "";
  if (!response.ok || !type.includes("application/pdf")) {
    let message = "Could not open the invoice.";
    try {
      const payload = (await response.json()) as { message?: string };
      message = payload.message || message;
    } catch {
      // keep default
    }
    throw new Error(message);
  }
  return response.blob();
}

export async function openInvoicePdf(invoiceId: string, kind: "shipping" | "sales" = "shipping") {
  await fetchInvoicePdfBlob(invoiceId, kind);
  const path = kind === "sales" ? `/api/v1/sales-invoices/${invoiceId}/download` : `/api/v1/invoices/${invoiceId}/download`;
  window.open(path, "_blank", "noopener,noreferrer");
}

function saveBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

export async function downloadInvoicePdf(invoiceId: string, filename: string, kind: "shipping" | "sales" = "shipping") {
  const blob = await fetchInvoicePdfBlob(invoiceId, kind);
  saveBlob(blob, filename.endsWith(".pdf") ? filename : `${filename}.pdf`);
}

export async function downloadInvoicePdfs(
  items: Array<{ id: string; filename: string; kind: "shipping" | "sales" }>,
  names: { zip: string; pdf: string },
  format: "zip" | "pdf" = "zip"
): Promise<{ downloaded: number; failed: number }> {
  if (items.length === 0) return { downloaded: 0, failed: 0 };
  const filenames = uniqueDownloadNames(items.map((item) => item.filename));
  if (items.length === 1) {
    await downloadInvoicePdf(items[0].id, filenames[0], items[0].kind);
    return { downloaded: 1, failed: 0 };
  }

  const files: Array<{ name: string; bytes: ArrayBuffer }> = [];
  let failed = 0;
  for (let index = 0; index < items.length; index += 1) {
    try {
      files.push({
        name: filenames[index],
        bytes: await (await fetchInvoicePdfBlob(items[index].id, items[index].kind)).arrayBuffer(),
      });
    } catch {
      failed += 1;
    }
  }
  if (files.length === 0) {
    throw new Error("Could not download those invoices. Try again.");
  }

  if (format === "pdf") {
    const merged = await mergeInvoicePdfs(files.map((file) => file.bytes));
    saveBlob(new Blob([new Uint8Array(merged)], { type: "application/pdf" }), names.pdf.endsWith(".pdf") ? names.pdf : `${names.pdf}.pdf`);
    return { downloaded: files.length, failed };
  }

  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  for (const file of files) zip.file(file.name, file.bytes);
  saveBlob(await zip.generateAsync({ type: "blob" }), names.zip.endsWith(".zip") ? names.zip : `${names.zip}.zip`);
  return { downloaded: files.length, failed };
}

async function mergeInvoicePdfs(buffers: ArrayBuffer[]) {
  const { PDFDocument } = await import("pdf-lib");
  const output = await PDFDocument.create();
  let merged = 0;
  for (const bytes of buffers) {
    try {
      const source = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      const pages = await output.copyPages(source, source.getPageIndices());
      for (const page of pages) output.addPage(page);
      merged += 1;
    } catch {
      // skip unreadable PDFs; caller still reports how many files were fetched
    }
  }
  if (merged === 0 || output.getPageCount() === 0) {
    throw new Error("Could not combine those invoices into one PDF. Try ZIP instead.");
  }
  return output.save();
}

export async function printInvoicePdf(invoiceId: string, kind: "shipping" | "sales" = "shipping") {
  const blob = await fetchInvoicePdfBlob(invoiceId, kind);
  const href = URL.createObjectURL(blob);
  const frame = document.createElement("iframe");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.src = href;
  const cleanup = () => {
    frame.remove();
    URL.revokeObjectURL(href);
  };
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } finally {
      window.setTimeout(cleanup, 60_000);
    }
  };
  document.body.appendChild(frame);
}
