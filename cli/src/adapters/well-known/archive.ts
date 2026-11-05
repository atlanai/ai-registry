import { gunzipSync, inflateRawSync } from "node:zlib";
import { isSafePath, plural } from "#adapter/index.ts";
import { fail } from "./errors.ts";

/** One file an archive holds. */
export interface Unpacked {
  /** POSIX, relative to the archive's root. */
  path: string;
  bytes: Uint8Array;
  executable: boolean;
}

/** How much one archive may unpack to, which a site cannot raise. */
interface ArchiveLimits {
  bytes: number;
  files: number;
}

const ARCHIVE_LIMITS: ArchiveLimits = { bytes: 50 * 1024 * 1024, files: 1000 };

const EXECUTE_BITS = 0o111;

/** Collects files, refusing what would leave the archive, repeat a path, or exceed the limits. */
class Collector {
  readonly files: Unpacked[] = [];
  readonly #seen = new Set<string>();
  #bytes = 0;

  readonly name: string;
  readonly limits: ArchiveLimits;

  constructor(name: string, limits: ArchiveLimits) {
    this.name = name;
    this.limits = limits;
  }

  add(raw: string, bytes: Uint8Array, executable: boolean): void {
    const path = raw.replace(/^\.\//, "");
    if (!isSafePath(path)) {
      throw fail(
        "invalid",
        `${this.name}'s archive holds ${JSON.stringify(raw)}, which is not a path inside it.`,
      );
    }
    if (this.#seen.has(path)) throw fail("invalid", `${this.name}'s archive holds ${path} twice.`);
    this.#seen.add(path);
    this.#bytes += bytes.byteLength;
    if (this.files.length + 1 > this.limits.files) {
      throw fail(
        "invalid",
        `${this.name}'s archive holds more than ${plural(this.limits.files, "file")}.`,
      );
    }
    if (this.#bytes > this.limits.bytes) {
      throw fail(
        "invalid",
        `${this.name}'s archive unpacks to more than ${Math.round(this.limits.bytes / 1024 / 1024)} MB.`,
      );
    }
    this.files.push({ path, bytes, executable });
  }

  refuse(path: string, what: string): never {
    throw fail(
      "invalid",
      `${this.name}'s archive holds ${JSON.stringify(path)}, which is ${what}.`,
    );
  }
}

const text = (bytes: Uint8Array, start: number, length: number) => {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
};

const octal = (bytes: Uint8Array, start: number, length: number) =>
  Number.parseInt(text(bytes, start, length).trim() || "0", 8);

/** A .tar.gz or a .zip, told apart by its first bytes, unpacked in memory within the limits. */
export function unpack(name: string, archive: Uint8Array, limits = ARCHIVE_LIMITS): Unpacked[] {
  const into = new Collector(name, limits);
  if (archive[0] === 0x1f && archive[1] === 0x8b) {
    let tar: Uint8Array;
    try {
      tar = gunzipSync(archive, { maxOutputLength: limits.bytes + 1024 * 1024 });
    } catch {
      throw fail(
        "invalid",
        `${name}'s archive is not a gzip file it can unpack within ${Math.round(limits.bytes / 1024 / 1024)} MB.`,
      );
    }
    untar(tar, into);
  } else if (archive[0] === 0x50 && archive[1] === 0x4b) {
    unzip(archive, into);
  } else {
    throw fail("invalid", `${name}'s archive is neither a .tar.gz nor a .zip file.`);
  }
  return into.files;
}

function untar(tar: Uint8Array, into: Collector): void {
  let at = 0;
  let longName: string | undefined;
  while (at + 512 <= tar.byteLength) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = text(header, 345, 155);
    const own = text(header, 0, 100);
    const name = longName ?? (prefix === "" ? own : `${prefix}/${own}`);
    const body = tar.subarray(at + 512, at + 512 + size);
    if (body.byteLength < size) throw fail("invalid", `${into.name}'s archive is cut short.`);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "x" || type === "L") {
      longName = type === "x" ? paxPath(body) : text(body, 0, body.byteLength);
      continue;
    }
    longName = undefined;
    if (type === "g" || type === "5") continue;
    if (type === "1" || type === "2") into.refuse(name, "a link");
    if (type !== "0" && type !== "\0") into.refuse(name, "not a regular file");
    into.add(name, body.slice(), (octal(header, 100, 8) & EXECUTE_BITS) !== 0);
  }
}

interface ZipEntry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  mode: number;
  local: number;
}

/** `path=` from a pax extended header, which names the next entry when its own name is too long. */
function paxPath(bytes: Uint8Array): string | undefined {
  for (const record of new TextDecoder().decode(bytes).split("\n")) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match !== null) return match[1];
  }
  return undefined;
}

/** The central directory says what a zip holds; each local header says where its bytes start. */
function unzip(zip: Uint8Array, into: Collector): void {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let at = zip.byteLength - 22; at >= Math.max(0, zip.byteLength - 65_557); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end === -1) throw fail("invalid", `${into.name}'s archive is not a zip file.`);
  let at = view.getUint32(end + 16, true);
  for (let count = view.getUint16(end + 10, true); count > 0; count -= 1) {
    const [entry, next] = centralEntry(zip, view, at, into.name);
    at = next;
    if (entry.name.endsWith("/")) continue;
    if ((entry.mode & 0o170000) === 0o120000) into.refuse(entry.name, "a link");
    into.add(entry.name, zipBytes(zip, view, entry, into), (entry.mode & EXECUTE_BITS) !== 0);
  }
}

/** One central directory record, and where the next one starts. */
function centralEntry(
  zip: Uint8Array,
  view: DataView,
  at: number,
  name: string,
): [ZipEntry, number] {
  if (at + 46 > zip.byteLength || view.getUint32(at, true) !== 0x02014b50) {
    throw fail("invalid", `${name}'s archive has a broken directory.`);
  }
  const length = view.getUint16(at + 28, true);
  const skip = length + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  const entry = {
    name: new TextDecoder().decode(zip.subarray(at + 46, at + 46 + length)),
    method: view.getUint16(at + 10, true),
    compressed: view.getUint32(at + 20, true),
    size: view.getUint32(at + 24, true),
    mode: view.getUint32(at + 38, true) >>> 16,
    local: view.getUint32(at + 42, true),
  };
  return [entry, at + 46 + skip];
}

/** A zip entry's bytes, stored or deflated, at exactly the size its directory gives. */
function zipBytes(zip: Uint8Array, view: DataView, entry: ZipEntry, into: Collector): Uint8Array {
  if (entry.compressed === 0xffffffff || entry.size === 0xffffffff) {
    into.refuse(entry.name, "too large to read");
  }
  if (entry.size > into.limits.bytes)
    into.refuse(entry.name, "larger than an archive may unpack to");
  const local = entry.local;
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const data = zip.subarray(start, start + entry.compressed);
  if (data.byteLength < entry.compressed)
    throw fail("invalid", `${into.name}'s archive is cut short.`);
  if (entry.method !== 0 && entry.method !== 8) {
    into.refuse(entry.name, "compressed in a way aireg does not read");
  }
  const bytes =
    entry.method === 0
      ? data.slice()
      : new Uint8Array(inflateRawSync(data, { maxOutputLength: into.limits.bytes }));
  if (bytes.byteLength !== entry.size) {
    throw fail("invalid", `${into.name}'s archive holds ${entry.name} at the wrong size.`);
  }
  return bytes;
}
