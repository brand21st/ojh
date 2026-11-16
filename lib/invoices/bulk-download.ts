export type InvoiceDownloadItem = {
  id: string;
  filename: string;
  kind: "shipping" | "sales";
};

export function uniqueDownloadNames(filenames: string[]): string[] {
  const used = new Set<string>();
  return filenames.map((name) => {
    const safe = name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
    const key = safe.toLowerCase();
    if (!used.has(key)) {
      used.add(key);
      return safe;
    }
    const dot = safe.lastIndexOf(".");
    const base = dot >= 0 ? safe.slice(0, dot) : safe;
    const ext = dot >= 0 ? safe.slice(dot) : "";
    let index = 2;
    let next = `${base}-${index}${ext}`;
    while (used.has(next.toLowerCase())) {
      index += 1;
      next = `${base}-${index}${ext}`;
    }
    used.add(next.toLowerCase());
    return next;
  });
}

export function mergeSelectedRows<T extends { id: string }>(previous: T[], visible: T[], ids: string[]): T[] {
  const visibleById = new Map(visible.map((row) => [row.id, row]));
  const previousById = new Map(previous.map((row) => [row.id, row]));
  const rows: T[] = [];
  for (const id of ids) {
    const row = visibleById.get(id) ?? previousById.get(id);
    if (row) rows.push(row);
  }
  return rows;
}

export function partitionInvoiceDownloads<T extends { id: string }>(
  rows: T[],
  canDownload: (row: T) => boolean,
  filename: (row: T) => string,
  kind: "shipping" | "sales"
): { items: InvoiceDownloadItem[]; skipped: number } {
  const items: InvoiceDownloadItem[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (!canDownload(row)) {
      skipped += 1;
      continue;
    }
    items.push({ id: row.id, filename: filename(row), kind });
  }
  return { items, skipped };
}

export function invoiceBulkDownloadMessage(downloaded: number, skipped: number, failed: number) {
  if (downloaded === 0 && failed === 0) {
    return skipped === 1
      ? "That invoice does not have a PDF yet."
      : "None of the selected invoices have a PDF yet.";
  }
  const parts = [
    downloaded === 1 ? "Saved 1 PDF." : `Saved ${downloaded} PDFs.`,
  ];
  if (skipped) {
    parts.push(skipped === 1 ? "1 was skipped because it has no PDF yet." : `${skipped} were skipped because they have no PDF yet.`);
  }
  if (failed) {
    parts.push(failed === 1 ? "1 could not be downloaded." : `${failed} could not be downloaded.`);
  }
  return parts.join(" ");
}
