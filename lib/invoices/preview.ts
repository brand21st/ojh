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
  zipName: string
): Promise<{ downloaded: number; failed: number }> {
  if (items.length === 0) return { downloaded: 0, failed: 0 };
  const names = uniqueDownloadNames(items.map((item) => item.filename));
  if (items.length === 1) {
    await downloadInvoicePdf(items[0].id, names[0], items[0].kind);
    return { downloaded: 1, failed: 0 };
  }

  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  let downloaded = 0;
  let failed = 0;
  for (let index = 0; index < items.length; index += 1) {
    try {
      zip.file(names[index], await fetchInvoicePdfBlob(items[index].id, items[index].kind));
      downloaded += 1;
    } catch {
      failed += 1;
    }
  }
  if (downloaded === 0) {
    throw new Error("Could not download those invoices. Try again.");
  }
  saveBlob(await zip.generateAsync({ type: "blob" }), zipName.endsWith(".zip") ? zipName : `${zipName}.zip`);
  return { downloaded, failed };
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
