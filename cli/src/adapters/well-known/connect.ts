import {
  type Artifact,
  buildEnvelope,
  describeFile,
  quoted,
  type Resolution,
  registryNameFromLocation,
  type SourceContext,
  type SourceHandle,
  sha256,
  type Want,
} from "#adapter/index.ts";
import { readFrontmatter, textField } from "#adapter/layouts/frontmatter.ts";
import { unpack } from "./archive.ts";
import { fail } from "./errors.ts";

/** The one index format aireg reads; an older one has no digests, and a newer one may differ. */
const SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

const INDEX = ".well-known/agent-skills/index.json";
const LEGACY = ".well-known/skills/index.json";

/** An Agent Skills name: lowercase letters and digits, single hyphens between them. */
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** An index is a page of text; a SKILL.md is one file; an archive is held to its own limit. */
const MAX_INDEX = 4 * 1024 * 1024;
const MAX_SKILL = 4 * 1024 * 1024;
const MAX_ARCHIVE = 50 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function connect(context: SourceContext): Promise<SourceHandle> {
  const { location, registry } = context.source;
  let site: URL;
  try {
    site = new URL(location);
  } catch {
    throw fail("invalid", `${location} is not a web address.`);
  }
  const namespace = registryNameFromLocation(location, site.hostname.replace(/\./g, "-"));
  const held = new Map<string, Map<string, Uint8Array>>();

  return {
    async resolve(want: readonly Want[], options): Promise<Resolution> {
      const pinned = want.find((item) => item.version !== undefined);
      if (pinned !== undefined) {
        throw fail(
          "invalid",
          `${registry} is a site's skills index, which has no versions, so ${pinned.name}@${pinned.version} cannot be installed.`,
          "Leave off the `@<version>`: aireg installs what the site serves now.",
        );
      }
      const warnings: string[] = [];
      const { url, document } = await readIndex(context, location, site);
      const entries = entriesOf(url, document, warnings).filter(
        (entry) =>
          options?.all === true ||
          want.length === 0 ||
          want.some(
            (item) => item.name === entry.name && (item.namespace ?? namespace) === namespace,
          ),
      );
      held.clear();
      const artifacts: Artifact[] = [];
      for (const entry of entries) {
        const files = await filesOf(context, entry);
        held.set(entry.name, new Map([...files].map(([path, file]) => [path, file.bytes])));
        artifacts.push(artifactOf(entry, files, namespace));
      }
      return {
        artifacts,
        registry: { name: namespace },
        layout: "well-known",
        ...(warnings.length === 0 ? {} : { warnings }),
      };
    },

    async fetch(artifact, file) {
      const bytes = held.get(artifact.id)?.get(file.locator);
      if (bytes === undefined) {
        throw fail("not_found", `${artifact.id} is not in the index aireg last read.`);
      }
      return bytes;
    },

    async close(): Promise<void> {
      held.clear();
    },
  };
}

async function readIndex(
  context: SourceContext,
  location: string,
  site: URL,
): Promise<{ url: URL; document: unknown }> {
  for (const url of indexUrls(location)) {
    const { status, bytes } = await get(context, url, MAX_INDEX);
    if (status === 404) continue;
    if (status !== 200) throw fail("unavailable", `${url.href} answered ${status}.`);
    try {
      return { url, document: JSON.parse(new TextDecoder().decode(bytes)) };
    } catch {
      throw fail("invalid", `${url.href} is not valid JSON.`);
    }
  }
  // An index without digests cannot be checked, so it is named rather than read.
  if ((await get(context, new URL(`/${LEGACY}`, site), MAX_INDEX)).status === 200) {
    throw fail(
      "invalid",
      `${site.origin} has only a /${LEGACY} index, which gives no digests, so aireg does not read it.`,
    );
  }
  throw fail(
    "not_found",
    `${location} has no Agent Skills index at ${indexUrls(location)
      .map((url) => url.href)
      .join(" or ")}.`,
    `If it is a git repository, add it with \`--adapter git\`.`,
  );
}

interface Entry {
  name: string;
  type: "skill-md" | "archive";
  description: string;
  url: URL;
  digest: string;
}

/** Where to look for the index: beside the address first, then at the site's root. */
function indexUrls(location: string): URL[] {
  const base = new URL(location);
  if (base.pathname.endsWith(`/${INDEX}`)) return [base];
  const folder = new URL(base.href.endsWith("/") ? base.href : `${base.href}/`);
  const urls = [new URL(INDEX, folder), new URL(`/${INDEX}`, base)];
  return urls.filter((url, at) => urls.findIndex((other) => other.href === url.href) === at);
}

type Files = Map<string, { bytes: Uint8Array; executable: boolean }>;

// No credentials and no cookies: a site's index is public, whatever host an entry names.
async function get(
  context: SourceContext,
  url: URL,
  limit: number,
): Promise<{ status: number; bytes: Uint8Array }> {
  if (!isSecure(url)) throw fail("invalid", `${url.href} has no transport security.`);
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(context.limits.timeoutMs)]);
  let response: Response;
  try {
    response = await fetch(url, { signal, credentials: "omit", redirect: "follow" });
  } catch (error) {
    if (context.signal.aborted) throw error;
    throw fail("unavailable", `Could not read ${url.href}: ${(error as Error).message}.`);
  }
  const landed = new URL(response.url || url.href);
  if (!isSecure(landed)) {
    throw fail(
      "invalid",
      `${url.href} sent aireg to ${landed.href}, which has no transport security.`,
    );
  }
  if (!response.ok) return { status: response.status, bytes: new Uint8Array() };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limit) throw fail("invalid", `${url.href} is larger than aireg reads.`);
  context.onBytes(bytes.byteLength);
  return { status: response.status, bytes };
}

function isSecure(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url));
}

/** Loopback as the host counts it, the one place plain http is allowed. */
function isLoopback(url: URL): boolean {
  const host = url.hostname;
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127\./.test(host)
  );
}

function entriesOf(url: URL, document: unknown, warnings: string[]): Entry[] {
  if (!isRecord(document) || document.$schema !== SCHEMA) {
    const named = isRecord(document) ? document.$schema : undefined;
    throw fail(
      "invalid",
      `${url.href} is ${typeof named === "string" ? `an index in ${quoted(named)}` : "not an index with a $schema"}, and aireg reads only ${SCHEMA}.`,
    );
  }
  if (!Array.isArray(document.skills)) throw fail("invalid", `${url.href} has no \`skills\` list.`);
  const entries: Entry[] = [];
  for (const raw of document.skills) {
    const entry = entryOf(url, isRecord(raw) ? raw : {}, warnings);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/** One index entry, checked; a skill aireg cannot read is skipped, a broken entry is an error. */
function entryOf(url: URL, item: Record<string, unknown>, warnings: string[]): Entry | undefined {
  const name = typeof item.name === "string" ? item.name : "";
  if (!NAME.test(name) || name.length > 64) {
    warnings.push(`Skipped ${quoted(name)}: it is not an Agent Skills name.`);
    return undefined;
  }
  if (item.type !== "skill-md" && item.type !== "archive") {
    warnings.push(`Skipped ${quoted(name)}: its type is not one aireg reads.`);
    return undefined;
  }
  const digest = typeof item.digest === "string" ? item.digest : "";
  if (!DIGEST.test(digest))
    throw fail("invalid", `${url.href} gives ${quoted(name)} no sha256 digest.`);
  let at: URL;
  try {
    at = new URL(String(item.url), url);
  } catch {
    throw fail("invalid", `${url.href} gives ${quoted(name)} a url that is not one.`);
  }
  // Another host is trusted no further than the digest the index gives it, and only over https.
  if (at.origin !== url.origin && at.protocol !== "https:") {
    throw fail(
      "invalid",
      `${url.href} sends ${quoted(name)} to ${at.href}, which is another host without https.`,
    );
  }
  const description = typeof item.description === "string" ? item.description : "";
  return { name, type: item.type, description, url: at, digest };
}

// Bytes that do not hash to the digest the index gives never land; the whole read fails.
async function filesOf(context: SourceContext, entry: Entry): Promise<Files> {
  const limit = entry.type === "archive" ? MAX_ARCHIVE : MAX_SKILL;
  const { status, bytes } = await get(context, entry.url, limit);
  if (status !== 200) throw fail("unavailable", `${entry.url.href} answered ${status}.`);
  const digest = sha256(bytes);
  if (digest !== entry.digest) {
    throw fail(
      "invalid",
      `${entry.name} at ${entry.url.href} hashes to ${digest}, not the ${entry.digest} the index gives, so nothing was installed from it.`,
    );
  }
  const files: Files = new Map();
  if (entry.type === "skill-md") {
    files.set("SKILL.md", { bytes, executable: false });
    return files;
  }
  for (const file of unpack(entry.name, bytes)) files.set(file.path, file);
  if (!files.has("SKILL.md")) {
    throw fail("invalid", `${entry.name}'s archive has no SKILL.md at its root.`);
  }
  return files;
}

function artifactOf(entry: Entry, files: Files, namespace: string): Artifact {
  const front = readFrontmatter(new TextDecoder().decode(files.get("SKILL.md")?.bytes));
  const description = textField(front, "description") ?? (entry.description || undefined);
  const envelope = buildEnvelope({
    kind: "skill",
    metadata: { name: entry.name, ...(description === undefined ? {} : { description }) },
    files: [...files].map(([path, file]) =>
      describeFile(path, sha256(file.bytes), file.bytes.byteLength),
    ),
    spec: { name: entry.name, ...(description === undefined ? {} : { description }) },
  });
  return {
    id: entry.name,
    kind: "skill",
    envelope,
    group: namespace,
    files: [...files].map(([path, file]) => ({
      path,
      locator: path,
      executable: file.executable,
    })),
  };
}
