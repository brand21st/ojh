import * as zlib from "node:zlib";

/**
 * A minimal streaming ZIP writer (STORE, no compression: MP4 does not compress).
 * Each file is read once and never held in memory whole, so a zip of a hundred
 * videos costs a few kilobytes of RAM. No ZIP64: callers keep the total under 4 GB.
 */

export type ZipEntry = {
  name: string;
  modifiedAt: Date;
  open: () => AsyncIterable<Uint8Array>;
};

export const ZIP_MAX_BYTES = 0xffffffff - 64 * 1024 * 1024;

const nativeCrc = (zlib as unknown as { crc32?: (data: Uint8Array, value?: number) => number }).crc32;

let table: Uint32Array | null = null;
function crcTable() {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

export function crc32(data: Uint8Array, previous = 0) {
  if (nativeCrc) return nativeCrc(data, previous) >>> 0;
  const t = crcTable();
  let c = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i += 1) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date) {
  const year = Math.max(date.getFullYear(), 1980);
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** Keeps names unique inside the archive: a second "EK1.mp4" becomes "EK1 (2).mp4". */
export function uniqueNames(names: string[]) {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const key = name.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 1) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? `${name.slice(0, dot)} (${count})${name.slice(dot)}` : `${name} (${count})`;
  });
}

export async function* zipStream(entries: ZipEntry[]): AsyncGenerator<Uint8Array> {
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const { time, day } = dosDateTime(entry.modifiedAt);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 names
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    // crc and sizes follow in the data descriptor
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    yield local;
    yield name;

    let crc = 0;
    let size = 0;
    for await (const chunk of entry.open()) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
      crc = crc32(bytes, crc);
      size += bytes.byteLength;
      yield bytes;
    }
    if (offset + 30 + name.length + size > ZIP_MAX_BYTES) {
      throw new Error("The zip is larger than 4 GB. Select fewer videos.");
    }

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor;

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0808, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(size, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += 30 + name.length + size + 16;
  }

  const directory = Buffer.concat(central);
  yield directory;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  yield end;
}

export function zipReadableStream(entries: ZipEntry[]) {
  const iterator = zipStream(entries);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}
