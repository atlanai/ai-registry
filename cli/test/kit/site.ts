import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, normalize } from "node:path";
import { gzipSync } from "node:zlib";
import { skillFile } from "#test/kit/builders/layouts.ts";

const SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

/** A folder served over http on loopback, as a site would serve it, for the length of a test. */
export async function serveFolder(
  root: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname));
    try {
      const bytes = await readFile(join(root, path));
      response.writeHead(200);
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** One entry of a tar archive: a file, or a link aireg must refuse. */
export interface TarEntry {
  path: string;
  body?: string;
  mode?: number;
  link?: string;
}

/** A ustar archive, written by hand so a test controls every header. */
export function tarGz(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    header.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write(entry.link === undefined ? "0" : "2", 156);
    if (entry.link !== undefined) header.write(entry.link, 157, 100);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.fill(" ", 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** A zip archive with every file stored uncompressed, which every reader must take. */
export function zip(files: Readonly<Record<string, string>>): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path);
    const body = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** One skill a site lists: its bytes, as a SKILL.md or an archive, and the digest the index gives. */
export interface SiteSkill {
  name: string;
  type?: "skill-md" | "archive";
  /** An archive's bytes; a SKILL.md is written from the name alone. */
  archive?: Uint8Array;
  /** Where the index says it is, relative to the index. */
  url?: string;
  /** The index's digest, when a test wants it wrong. */
  digest?: string;
}

/** A site with an Agent Skills index at `/.well-known/agent-skills/index.json`, listing `skills`. */
export async function wellKnownSite(
  root: string,
  skills: readonly SiteSkill[],
  schema = SCHEMA,
): Promise<string> {
  const folder = join(root, ".well-known", "agent-skills");
  const entries = [];
  for (const skill of skills) {
    const type = skill.type ?? "skill-md";
    const bytes = skill.archive ?? Buffer.from(skillFile(skill.name));
    const url =
      skill.url ?? (type === "archive" ? `${skill.name}.tar.gz` : `${skill.name}/SKILL.md`);
    // An entry on another host is never served from here.
    if (!/^[a-z][a-z\d+.-]*:/i.test(url)) {
      await mkdir(dirname(join(folder, url)), { recursive: true });
      await writeFile(join(folder, url), bytes);
    }
    entries.push({
      name: skill.name,
      type,
      description: `${skill.name}.`,
      url,
      digest: skill.digest ?? digest(bytes),
    });
  }
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "index.json"), JSON.stringify({ $schema: schema, skills: entries }));
  return root;
}
