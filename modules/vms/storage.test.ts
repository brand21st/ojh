import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  absoluteVideoPath,
  appendChunk,
  commitPart,
  detectVideoMime,
  partSize,
  relativeVideoPath,
  sniffVideo,
} from "@/modules/vms/storage";
import { downloadName, parseIds, parseRange, searchTerm } from "@/modules/vms/service";

const ORG = "6f1c2b9e-1111-4a2b-9c3d-000000000001";
const OTHER = "6f1c2b9e-1111-4a2b-9c3d-000000000002";
const VIDEO = "7a2d3c4f-2222-4b3c-8d4e-000000000003";

let base: string;

beforeAll(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "vms-"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const mp4Head = Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

describe("video storage", () => {
  it("appends pieces only at the current end, so retries cannot duplicate bytes", async () => {
    expect(await appendChunk(ORG, VIDEO, 0, mp4Head, base)).toEqual({ ok: true, size: 12 });
    // A retried first piece is refused and told where the file ends.
    expect(await appendChunk(ORG, VIDEO, 0, mp4Head, base)).toEqual({ ok: false, size: 12 });
    expect(await appendChunk(ORG, VIDEO, 12, Uint8Array.from([1, 2, 3]), base)).toEqual({ ok: true, size: 15 });
    expect(await partSize(ORG, VIDEO, base)).toBe(15);
    expect(await sniffVideo(ORG, VIDEO, base)).toBe("video/mp4");

    const relative = await commitPart(ORG, VIDEO, "video/mp4", base);
    expect(relative).toBe(`${ORG}/${VIDEO}.mp4`);
    const bytes = await readFile(absoluteVideoPath(relative, ORG, base));
    expect(bytes.byteLength).toBe(15);
    expect(await partSize(ORG, VIDEO, base)).toBe(0);
  });

  it("refuses paths outside the workspace folder", () => {
    expect(() => absoluteVideoPath(`${ORG}/${VIDEO}.mp4`, OTHER, base)).toThrow(/access/);
    expect(() => absoluteVideoPath(`../${VIDEO}.mp4`, ORG, base)).toThrow();
    expect(() => absoluteVideoPath(`${ORG}/../../etc/passwd`, ORG, base)).toThrow();
    expect(() => relativeVideoPath("not-a-uuid", VIDEO, "video/mp4")).toThrow();
  });

  it("recognises MP4 and WebM and rejects anything else", () => {
    expect(detectVideoMime(mp4Head)).toBe("video/mp4");
    expect(detectVideoMime(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]))).toBe("video/webm");
    expect(detectVideoMime(new TextEncoder().encode("<html>hello</html>"))).toBeNull();
  });
});

describe("video service helpers", () => {
  it("parses byte ranges for video seeking", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=0-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=2000-", 1000)).toBe("invalid");
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange("bytes=0-1,5-9", 1000)).toBeNull();
  });

  it("cleans search text so it cannot break the PostgREST filter", () => {
    expect(searchTerm(" ek12,3(4)*  ")).toBe("EK1234");
    expect(searchTerm("#1001")).toBe("#1001");
    expect(searchTerm("a")).toBe("");
    expect(searchTerm(undefined)).toBe("");
  });

  it("names downloads by barcode and IST time", () => {
    expect(downloadName({ barcode: "EK123456789IN", started_at: "2026-11-27T04:10:23Z", mime_type: "video/mp4" })).toBe(
      "EK123456789IN_2026-11-27_094023.mp4"
    );
    expect(downloadName({ barcode: "#10/01 x", started_at: "2026-11-27T04:10:23Z", mime_type: "video/webm" })).toBe(
      "10-01-x_2026-11-27_094023.webm"
    );
  });

  it("keeps only valid, unique ids", () => {
    expect(parseIds(`${VIDEO},nope,${VIDEO}, ${ORG}`)).toEqual([VIDEO, ORG]);
    expect(parseIds(null)).toEqual([]);
  });
});
