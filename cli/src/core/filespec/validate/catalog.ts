import { join, posix } from "node:path";
import { isRecord } from "#adapter/fields.ts";
import { readJson } from "#adapter/filespec/documents.ts";
import { rootReader } from "#adapter/filespec/folder.ts";
import { newest } from "#adapter/filespec/merge.ts";
import {
  ARTIFACTS_DIR,
  ENVELOPE,
  INDEX_DOCUMENT,
  isArtifactName,
  isKindSegment,
  isNamespace,
  VERSIONS_DOCUMENT,
  versionsPath,
} from "#adapter/filespec/names.ts";
import { contentDigest, type Envelope } from "#adapter/index.ts";
import { catalogDigest } from "#adapter/spec/canonical.ts";
import { isVersion } from "#adapter/spec/ref.ts";
import { exists, subdirectories } from "#core/fs/tree.ts";
import { type Problem, readDocument } from "./read.ts";

/** Section 3: the documents describe one catalog, so they must agree. */
export async function catalogProblems(
  root: string,
  held: ReadonlySet<string>,
  index: unknown,
): Promise<Problem[]> {
  const rows = new Map<string, Record<string, unknown>>();
  const entries = (index as { entries?: unknown } | undefined)?.entries;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const row = entry as Record<string, unknown>;
    rows.set(`${row.namespace}/${row.kind}/${row.name}`, row);
  }
  const problems: Problem[] = [];
  const keys = await catalogued(root);
  for (const key of keys) {
    const [namespace = "", kind = "", name = ""] = key.split("/");
    const at = versionsPath(namespace, kind, name);
    const document = await readDocument(root, at);
    if (document === undefined) continue;
    problems.push(...versionsProblems(at, document, { namespace, kind, name }));
    problems.push(...(await rowProblems(root, at, key, document, held)));
    problems.push(...indexRowProblems(key, rows.get(key), document));
  }
  const kept = new Set(keys);
  for (const key of rows.keys()) {
    if (kept.has(key)) continue;
    problems.push({
      path: INDEX_DOCUMENT,
      message: `lists ${key}, which has no versions.json`,
      fix: "aireg registry index",
    });
  }
  return problems;
}

/** Each `<namespace>/<kind>/<name>` with a `versions.json`, even one with no version folder left. */
async function catalogued(root: string): Promise<string[]> {
  const found: string[] = [];
  const base = join(root, ARTIFACTS_DIR);
  for (const namespace of (await subdirectories(base)).filter(isNamespace)) {
    for (const kind of (await subdirectories(join(base, namespace))).filter(isKindSegment)) {
      for (const name of await subdirectories(join(base, namespace, kind))) {
        if (!isArtifactName(name)) continue;
        if (await exists(join(base, namespace, kind, name, VERSIONS_DOCUMENT))) {
          found.push(`${namespace}/${kind}/${name}`);
        }
      }
    }
  }
  return found;
}

/** A `versions.json` names its own folder and the newest active release. */
function versionsProblems(
  at: string,
  document: Record<string, unknown>,
  named: Record<"namespace" | "kind" | "name", string>,
): Problem[] {
  const problems: Problem[] = [];
  for (const [field, folder] of Object.entries(named)) {
    if (document[field] !== folder) {
      problems.push({
        path: at,
        message: `${field} is ${String(document[field])}, but its folder says ${folder}`,
      });
    }
  }
  const want = newest(Array.isArray(document.versions) ? document.versions : []);
  if (want !== undefined && document.latest !== want) {
    problems.push({
      path: at,
      message: `latest is ${String(document.latest)}, but the newest active release is ${want}`,
      fix: "aireg registry index",
    });
  }
  return problems;
}

/** Rule 1: every listed version keeps its folder, and a `catalog_digest` covers its row. */
async function rowProblems(
  root: string,
  at: string,
  key: string,
  document: Record<string, unknown>,
  held: ReadonlySet<string>,
): Promise<Problem[]> {
  const problems: Problem[] = [];
  const versions = Array.isArray(document.versions) ? document.versions : [];
  for (const row of versions) {
    if (!isRecord(row) || typeof row.version !== "string" || !isVersion(row.version)) continue;
    const folder = `${posix.dirname(at)}/${row.version}`;
    if (!held.has(`${key}@${row.version}`)) {
      problems.push({
        path: folder,
        message: `is missing, but versions.json lists ${row.version}`,
        fix: `restore ${folder}/, or if ${row.version} was never released, remove it from versions.json`,
      });
      continue;
    }
    if (typeof row.catalog_digest !== "string") continue;
    const envelope = await readJson(rootReader(root), `${folder}/${ENVELOPE}`).catch(
      () => undefined,
    );
    if (!isRecord(envelope) || !isRecord(envelope.metadata)) continue;
    const want = catalogDigest(envelope as unknown as Envelope, row);
    if (row.catalog_digest === want) continue;
    // With the content as released, only the row's status moved it, and indexing recomputes it.
    const indexed = contentDigest(envelope as unknown as Envelope) === row.digest;
    problems.push({
      path: at,
      message: `catalog_digest of ${row.version} is ${row.catalog_digest}, but its row and envelope give ${want}`,
      ...(indexed ? { fix: "aireg registry index" } : {}),
    });
  }
  return problems;
}

/** The `index.json` row repeats the release `versions.json` calls latest, and its digest. */
function indexRowProblems(
  key: string,
  row: Record<string, unknown> | undefined,
  document: Record<string, unknown>,
): Problem[] {
  if (row === undefined) return [];
  const fix = "aireg registry index";
  if (row.latest !== document.latest) {
    return [
      {
        path: INDEX_DOCUMENT,
        message: `${key} latest is ${String(row.latest)}, but versions.json says ${String(document.latest)}`,
        fix,
      },
    ];
  }
  const versions = Array.isArray(document.versions) ? document.versions : [];
  const pinned = versions.find(
    (item) => (item as { version?: unknown }).version === document.latest,
  ) as { digest?: unknown } | undefined;
  if (pinned === undefined || row.digest === pinned.digest) return [];
  return [
    {
      path: INDEX_DOCUMENT,
      message: `${key} digest is ${String(row.digest)}, but versions.json says ${String(pinned.digest)}`,
      fix,
    },
  ];
}
