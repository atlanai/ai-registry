import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { buildEnvelope, type Envelope } from "#adapter/index.ts";

/**
 * Writes a file spec root, which is the only thing a registry is: tests build
 * one rather than a folder of loose skills, because that is what the client reads.
 */

export interface SpecVersion {
  version: string;
  description?: string;
  /** Path under the version directory to its contents. */
  files: Record<string, string>;
  /** Published then withdrawn: skipped for `latest`, still resolvable by pin. */
  yanked?: boolean;
  /** Why it was yanked, as `versions.json` records it. */
  reason?: string;
  /** `active` unless set, as `versions.json` records it. */
  status?: string;
  /** Fully qualified refs this version's `depends_on` edges name. */
  dependsOn?: readonly string[];
}

export interface SpecArtifact {
  namespace: string;
  kind: "skill" | "agent";
  name: string;
  /** Defaults to the last active version that is not yanked, as the spec picks it. */
  latest?: string;
  versions: readonly SpecVersion[];
}

const GENERATED_AT = "2026-01-01T00:00:00Z";

function digestOf(body: string): { digest: string; size: number } {
  const bytes = Buffer.from(body, "utf8");
  return {
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size: bytes.length,
  };
}

function envelopeFor(artifact: SpecArtifact, version: SpecVersion): Envelope {
  return buildEnvelope({
    kind: artifact.kind,
    metadata: {
      name: artifact.name,
      namespace: artifact.namespace,
      version: version.version,
      ...(version.description === undefined ? {} : { description: version.description }),
    },
    files: Object.entries(version.files).map(([path, body]) => ({
      path,
      ...digestOf(body),
      urls: [path],
    })),
    relationships: (version.dependsOn ?? []).map((to) => ({ rel_type: "depends_on", to })),
  });
}

async function write(root: string, path: string, body: string): Promise<void> {
  const full = join(root, ...path.split(posix.sep));
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, body, "utf8");
}

async function writeJson(root: string, path: string, value: unknown): Promise<void> {
  await write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The default skill body, so a fixture only says what it cares about. */
export function skillBody(name: string, description = name, extra = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${extra}`;
}

/**
 * One version is latest for both documents: the client resolves through
 * versions.json, so an index that disagreed would name an unreachable root.
 */
function latestOf(artifact: SpecArtifact): SpecVersion {
  const versions = artifact.versions;
  const last = versions.at(-1);
  if (last === undefined) throw new Error(`${artifact.name} has no versions.`);
  if (artifact.latest !== undefined) {
    const named = versions.find((entry) => entry.version === artifact.latest);
    if (named === undefined) throw new Error(`${artifact.name} has no ${artifact.latest}.`);
    return named;
  }
  const offered = [...versions].reverse().filter((entry) => entry.yanked !== true);
  return offered.find((entry) => (entry.status ?? "active") === "active") ?? offered[0] ?? last;
}

/** Ordered so a reader can see which version a registry published first. */
function publishedAt(at: number): string {
  return new Date(Date.UTC(2026, 0, 1 + at)).toISOString().replace(".000Z", "Z");
}

async function writeArtifact(root: string, artifact: SpecArtifact): Promise<unknown> {
  const dir = `artifacts/${artifact.namespace}/${artifact.kind}/${artifact.name}`;
  const latest = latestOf(artifact);
  const rows: unknown[] = [];
  let latestDigest: string | undefined;

  for (const [at, version] of artifact.versions.entries()) {
    const envelope = envelopeFor(artifact, version);
    for (const [path, body] of Object.entries(version.files)) {
      await write(root, `${dir}/${version.version}/${path}`, body);
    }
    await writeJson(root, `${dir}/${version.version}/artifact.json`, envelope);
    if (version === latest) latestDigest = envelope.metadata.digest;
    rows.push({
      version: version.version,
      digest: envelope.metadata.digest,
      published_at: publishedAt(at),
      status: version.status ?? "active",
      yanked: version.yanked === true,
      ...(version.reason === undefined ? {} : { reason: version.reason }),
    });
  }

  await writeJson(root, `${dir}/versions.json`, {
    namespace: artifact.namespace,
    kind: artifact.kind,
    name: artifact.name,
    latest: latest.version,
    versions: rows,
  });

  return {
    namespace: artifact.namespace,
    kind: artifact.kind,
    name: artifact.name,
    latest: latest.version,
    digest: latestDigest,
    status: latest.status ?? "active",
    ...(latest.description === undefined ? {} : { description: latest.description }),
  };
}

export async function writeSpecRoot(
  root: string,
  artifacts: readonly SpecArtifact[],
  options: { name?: string; slug?: string } = {},
): Promise<void> {
  const entries: unknown[] = [];
  for (const artifact of artifacts) entries.push(await writeArtifact(root, artifact));

  await writeJson(root, "registry.json", {
    kind: "registry",
    format_version: 1,
    name: options.name ?? basename(root),
    ...(options.slug === undefined ? {} : { slug: options.slug }),
    capabilities: ["files"],
    auth: { type: "none" },
    blob_url: "blobs/sha256/{digest}",
  });
  await writeJson(root, "index.json", {
    format_version: 1,
    generated_at: GENERATED_AT,
    entries,
  });
}
