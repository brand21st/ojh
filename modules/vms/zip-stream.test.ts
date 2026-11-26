import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { crc32, uniqueNames, zipStream, type ZipEntry } from "@/modules/vms/zip-stream";

async function collect(entries: ZipEntry[]) {
  const parts: Uint8Array[] = [];
  for await (const part of zipStream(entries)) parts.push(part);
  return Buffer.concat(parts);
}

function entry(name: string, ...chunks: string[]): ZipEntry {
  return {
    name,
    modifiedAt: new Date(2026, 10, 27, 9, 40, 22),
    async *open() {
      for (const chunk of chunks) yield new TextEncoder().encode(chunk);
    },
  };
}

describe("zipStream", () => {
  it("writes an archive that a standard zip reader opens", async () => {
    const buffer = await collect([entry("EK123456789IN.mp4", "first ", "video"), entry("ORDER-1001.webm", "second")]);
    const zip = await JSZip.loadAsync(buffer);
    expect(Object.keys(zip.files).sort()).toEqual(["EK123456789IN.mp4", "ORDER-1001.webm"]);
    expect(await zip.file("EK123456789IN.mp4")!.async("string")).toBe("first video");
    expect(await zip.file("ORDER-1001.webm")!.async("string")).toBe("second");
  });

  it("handles an empty file and an empty archive", async () => {
    const zip = await JSZip.loadAsync(await collect([entry("empty.mp4")]));
    expect(await zip.file("empty.mp4")!.async("string")).toBe("");
    const none = await JSZip.loadAsync(await collect([]));
    expect(Object.keys(none.files)).toHaveLength(0);
  });

  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const whole = crc32(new TextEncoder().encode("hello world"));
    const split = crc32(new TextEncoder().encode("world"), crc32(new TextEncoder().encode("hello ")));
    expect(split).toBe(whole);
  });

  it("makes duplicate names unique", () => {
    expect(uniqueNames(["A.mp4", "a.mp4", "B.mp4", "A.mp4"])).toEqual(["A.mp4", "a (2).mp4", "B.mp4", "A (3).mp4"]);
  });
});
