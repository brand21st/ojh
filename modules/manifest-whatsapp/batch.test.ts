import { describe, expect, it } from "vitest";
import { chunkFiles, MANIFEST_WHATSAPP_MAX_FILES_PER_BATCH } from "@/modules/manifest-whatsapp/batch";

describe("manifest WhatsApp file batches", () => {
  it("keeps the logical cap at five files", () => {
    expect(MANIFEST_WHATSAPP_MAX_FILES_PER_BATCH).toBe(5);
  });

  it("places one file in a single batch", () => {
    expect(chunkFiles(["a"])).toEqual([["a"]]);
  });

  it("places five files in a single batch", () => {
    expect(chunkFiles(["a", "b", "c", "d", "e"])).toEqual([["a", "b", "c", "d", "e"]]);
  });

  it("splits six files into five plus one", () => {
    expect(chunkFiles(["1", "2", "3", "4", "5", "6"])).toEqual([
      ["1", "2", "3", "4", "5"],
      ["6"],
    ]);
  });

  it("splits twelve files into five, five, and two", () => {
    const files = Array.from({ length: 12 }, (_, i) => String(i + 1));
    expect(chunkFiles(files)).toEqual([
      ["1", "2", "3", "4", "5"],
      ["6", "7", "8", "9", "10"],
      ["11", "12"],
    ]);
  });

  it("returns no batches for an empty list", () => {
    expect(chunkFiles([])).toEqual([]);
  });
});
