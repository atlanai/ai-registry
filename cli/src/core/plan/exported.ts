import { posix } from "node:path";
import type { SourceArtifact, SourceManifest } from "#adapter/index.ts";
import { quoted, sanitizeText } from "#adapter/text.ts";
import { canonicalRegistryUrl } from "#core/adapter/identity.ts";
import { SKILL_ENTRY } from "#core/kinds.ts";
import {
  artifactFor,
  type Export,
  type ExportDependency,
  isGlob,
  type Manifest,
  readSourceManifest,
} from "#core/manifest.ts";
import { formatAddress } from "#core/ref.ts";
import { MANIFEST_FILE, SCOPE_DIR } from "#core/store/paths.ts";
import type { Need } from "./depends.ts";

// A repository installed as a folder of skills may be a project that exports some of them. Its
// manifest's `depends_on` gives those their edges: one to another export of the source names it
// with no version, as both are read at one commit, and one to an artifact the project installs
// takes that artifact's range and the address of the registry the project declares it in.

/** The edges a source's exports give, by the id each artifact is listed with, and what was left out. */
export interface Exported {
  needs: Map<string, Need[]>;
  warnings: string[];
}

const WHERE = `${SCOPE_DIR}/${MANIFEST_FILE}`;

/** A skill is its folder, however an entry reaches it, so one path names one export. */
function artifactRoot(path: string): string {
  return posix.basename(path) === SKILL_ENTRY ? posix.dirname(path) : path;
}

/**
 * The dependencies each path's entries give it, combined, since every entry naming a path applies
 * to it. Only a mapping has `depends_on`, and a mapping names one path, never a glob, so no glob of
 * the source's is ever matched: one written to be slow to match costs nothing here.
 */
function exportsAt(entries: readonly Export[]): Map<string, ExportDependency[]> {
  const at = new Map<string, Map<string, ExportDependency>>();
  for (const entry of entries) {
    if (isGlob(entry.path)) continue;
    const root = artifactRoot(entry.path);
    const needs = at.get(root) ?? new Map<string, ExportDependency>();
    for (const need of entry.dependsOn) {
      const key = need.type === "local" ? `./${artifactRoot(need.path)}` : formatAddress(need.ref);
      if (!needs.has(key)) needs.set(key, need);
    }
    if (needs.size > 0) at.set(root, needs);
  }
  return new Map([...at].map(([root, needs]) => [root, [...needs.values()]]));
}

function leftOut(name: string, to: string, why: string): string {
  return `"${sanitizeText(name)}" depends on "${sanitizeText(to)}", ${why}; it was left out.`;
}

/** One `depends_on` entry as the edge it gives, or why it gives none. */
function needOf(
  dependency: ExportDependency,
  manifest: Manifest,
  byPath: ReadonlyMap<string, SourceArtifact>,
): Need | string {
  if (dependency.type === "local") {
    const sibling = byPath.get(artifactRoot(dependency.path));
    if (sibling?.namespace === undefined) return "which this source does not hold";
    // Read at the one commit its dependent is, so the edge needs no version to be exact.
    return { namespace: sibling.namespace, kind: sibling.kind, name: sibling.name };
  }
  const { ref } = dependency;
  const location = manifest.registries[ref.registry]?.location ?? "";
  // Only the address the project declares says which registry it means, and only by its https
  // form; whether this project declares that registry is for the closure to settle.
  const registry = canonicalRegistryUrl(location);
  if (registry === undefined) {
    return `in a registry the source declares at ${quoted(sanitizeText(location))}, which has no https address`;
  }
  const entry = artifactFor(manifest.artifacts, ref);
  return {
    namespace: ref.namespace as string,
    kind: ref.kind as Need["kind"],
    name: ref.name as string,
    ...(entry?.version === undefined ? {} : { version: entry.version }),
    ...(entry?.range === undefined ? {} : { range: entry.range }),
    registry,
  };
}

/**
 * The `depends_on` edges a source manifest's exports give the artifacts a source listed. A
 * manifest that does not read gives none, with a warning, and so does an edge it cannot follow.
 */
export function exportedNeeds(
  source: SourceManifest,
  listed: readonly { id: string; name: string }[],
): Exported {
  const needs = new Map<string, Need[]>();
  const warnings: string[] = [];
  const manifest = readSourceManifest(source.text);
  if ("problem" in manifest) {
    warnings.push(
      `Ignored ${WHERE}, which aireg cannot read (${sanitizeText(manifest.problem)}), so what it exports installs without its dependencies.`,
    );
    return { needs, warnings };
  }
  if (manifest.exports.length === 0) return { needs, warnings };
  const byPath = new Map(source.artifacts.map((artifact) => [artifact.path, artifact]));
  const byId = new Map(source.artifacts.map((artifact) => [artifact.id, artifact]));
  const at = exportsAt(manifest.exports);
  for (const { id, name } of listed) {
    const path = byId.get(id)?.path;
    const dependencies = path === undefined ? undefined : at.get(path);
    if (dependencies === undefined) continue;
    const edges: Need[] = [];
    for (const dependency of dependencies) {
      const need = needOf(dependency, manifest, byPath);
      if (typeof need !== "string") edges.push(need);
      else {
        const to =
          dependency.type === "local" ? `./${dependency.path}` : formatAddress(dependency.ref);
        warnings.push(leftOut(name, to, need));
      }
    }
    if (edges.length > 0) needs.set(id, edges);
  }
  return { needs, warnings };
}
