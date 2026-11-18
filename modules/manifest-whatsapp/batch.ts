export const MANIFEST_WHATSAPP_MAX_FILES_PER_BATCH = 5;

export function chunkFiles<T>(files: T[], size = MANIFEST_WHATSAPP_MAX_FILES_PER_BATCH): T[][] {
  const limit = Number.isInteger(size) && size > 0 ? size : MANIFEST_WHATSAPP_MAX_FILES_PER_BATCH;
  const batches: T[][] = [];
  for (let index = 0; index < files.length; index += limit) {
    batches.push(files.slice(index, index + limit));
  }
  return batches;
}
