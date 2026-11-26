import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { env } from "@/lib/env";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type VideoMime = "video/mp4" | "video/webm";

export function extensionFor(mime: VideoMime) {
  return mime === "video/webm" ? "webm" : "mp4";
}

function root(base = env.vmsStoragePath) {
  return path.resolve(base);
}

/** Paths are built only from validated UUIDs, never from anything the client sent. */
export function relativeVideoPath(organizationId: string, videoId: string, mime: VideoMime) {
  if (!UUID.test(organizationId) || !UUID.test(videoId)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Invalid video path.");
  }
  return `${organizationId.toLowerCase()}/${videoId.toLowerCase()}.${extensionFor(mime)}`;
}

function partPath(organizationId: string, videoId: string, base?: string) {
  if (!UUID.test(organizationId) || !UUID.test(videoId)) {
    throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Invalid video path.");
  }
  return path.join(root(base), organizationId.toLowerCase(), `${videoId.toLowerCase()}.part`);
}

/** Resolves a stored relative path, refusing anything outside the workspace's folder. */
export function absoluteVideoPath(relative: string, organizationId: string, base?: string) {
  const posix = (relative ?? "").replace(/\\/g, "/");
  const match = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\.(mp4|webm)$/i.exec(posix);
  if (!match || match[1].toLowerCase() !== organizationId.toLowerCase()) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "You do not have access to this video.");
  }
  return path.join(root(base), match[1].toLowerCase(), `${match[2].toLowerCase()}.${match[3].toLowerCase()}`);
}

export async function partSize(organizationId: string, videoId: string, base?: string) {
  try {
    return (await stat(partPath(organizationId, videoId, base))).size;
  } catch {
    return 0;
  }
}

/**
 * Appends one uploaded piece. The client says where the piece starts; a piece that
 * does not start at the current end of the file is refused so a retried upload can
 * never duplicate or skip bytes. Returns the new size.
 */
export async function appendChunk(
  organizationId: string,
  videoId: string,
  offset: number,
  bytes: Uint8Array,
  base?: string
) {
  const file = partPath(organizationId, videoId, base);
  await mkdir(path.dirname(file), { recursive: true });
  const current = await partSize(organizationId, videoId, base);
  if (current !== offset) return { ok: false as const, size: current };
  await appendFile(file, bytes);
  return { ok: true as const, size: current + bytes.byteLength };
}

/** Reads the first bytes so a non-video upload is never saved as one. */
export async function sniffVideo(organizationId: string, videoId: string, base?: string): Promise<VideoMime | null> {
  const handle = await open(partPath(organizationId, videoId, base), "r");
  try {
    const head = Buffer.alloc(12);
    await handle.read(head, 0, 12, 0);
    return detectVideoMime(head);
  } finally {
    await handle.close();
  }
}

export function detectVideoMime(head: Uint8Array): VideoMime | null {
  if (head.length >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return "video/mp4";
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video/webm";
  return null;
}

export async function commitPart(organizationId: string, videoId: string, mime: VideoMime, base?: string) {
  const relative = relativeVideoPath(organizationId, videoId, mime);
  await rename(partPath(organizationId, videoId, base), absoluteVideoPath(relative, organizationId, base));
  return relative;
}

export async function removePart(organizationId: string, videoId: string, base?: string) {
  await rm(partPath(organizationId, videoId, base), { force: true });
}

export async function removeVideo(relative: string, organizationId: string, base?: string) {
  await rm(absoluteVideoPath(relative, organizationId, base), { force: true });
}

export async function videoFileSize(relative: string, organizationId: string, base?: string) {
  try {
    return (await stat(absoluteVideoPath(relative, organizationId, base))).size;
  } catch {
    return null;
  }
}

export function videoReadStream(
  relative: string,
  organizationId: string,
  range?: { start: number; end: number },
  base?: string
) {
  const stream = createReadStream(absoluteVideoPath(relative, organizationId, base), range);
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

export function nodeVideoStream(relative: string, organizationId: string, base?: string) {
  return createReadStream(absoluteVideoPath(relative, organizationId, base));
}
