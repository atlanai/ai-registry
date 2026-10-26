import { rm } from "node:fs/promises";
import { join } from "node:path";
import { list, quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { authoredDigest } from "#core/fs/digest.ts";
import { posixRelative } from "#core/fs/path.ts";
import { authoredArtifact, copyAuthored, exists, type Irregular, refusal } from "#core/fs/tree.ts";
import type { ArtifactKind } from "#core/kinds.ts";
import { emptyLock, type Lock, writeLock } from "#core/lock.ts";
import { guardManagedPath } from "#core/store/managed-paths.ts";
import { artifactPath, type Roots, type Scope } from "#core/store/paths.ts";
import { type Candidate, candidates, displayPath } from "#core/sync/adopt.ts";
import type { CommonOptions } from "#engine/options.ts";
import { type Loaded, load, scopeRoots, withScope } from "#engine/pipeline.ts";

interface Found {
  name: string;
  kind: ArtifactKind;
  artifactPath: string;
  digest: string;
  occurrences: readonly Candidate[];
}

/** What `init --import` found in the target folders, checked before anything is written. */
export interface ImportPlan {
  root: string;
  scope: Scope;
  artifacts: readonly Found[];
}

/** Said before anything is copied, the way a publish would say it, so nothing is half imported. */
async function refuseIrregular(roots: Roots, from: string, found?: Irregular): Promise<void> {
  const refused = found ?? (await authoredArtifact(from)).irregular[0];
  if (refused === undefined) return;
  const at = displayPath(roots, refused.path === "" ? from : join(from, refused.path));
  throw new AiregError(`Did not import ${at}: it ${refusal(refused)}.`, {
    code: ErrorCode.Invalid,
    hint: "Nothing was imported. Fix that entry and run the import again.",
  });
}

function common(scope: Scope): CommonOptions {
  return {
    scope,
    targets: undefined,
    select: undefined,
    yes: true,
    all: true,
    dryRun: false,
    frozen: false,
    force: false,
    copy: false,
  };
}

export async function planImport(
  root: string,
  targets: readonly string[],
  scope: Scope,
): Promise<ImportPlan> {
  const loaded = await load(common(scope), root);
  const groups = new Map<string, Candidate[]>();
  for (const id of targets) {
    const found = await candidates(loaded.roots, loaded.targetTable, [id], emptyLock());
    for (const item of found.local.filter(({ target }) => target === id)) {
      const key = `${item.kind}:${item.name}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
  }

  const artifacts: Found[] = [];
  for (const occurrences of groups.values()) {
    for (const { from } of occurrences) await refuseIrregular(loaded.roots, from);
    const digests = await Promise.all(occurrences.map(({ from }) => authoredDigest(from)));
    const first = occurrences[0] as Candidate;
    if (new Set(digests).size !== 1) {
      const where = occurrences.map(({ from }) => displayPath(loaded.roots, from));
      throw new AiregError(`Found different copies of ${quoted(first.name)}.`, {
        code: ErrorCode.Conflict,
        hint: `Make ${list(where)} match, or import from one target with \`--import <target>\`.`,
      });
    }
    artifacts.push({
      name: first.name,
      kind: first.kind,
      artifactPath: first.suggestedPath,
      digest: digests[0] as string,
      occurrences,
    });
  }
  const names = new Set<string>();
  for (const artifact of artifacts) {
    if (names.has(artifact.name)) {
      throw new AiregError(`Found ${quoted(artifact.name)} as more than one kind of artifact.`, {
        code: ErrorCode.Conflict,
        hint: "Rename one of them, then run the import again.",
      });
    }
    names.add(artifact.name);
  }
  artifacts.sort((left, right) => left.name.localeCompare(right.name));
  return { root, scope, artifacts };
}

/**
 * Copies each artifact into the registry and records it in the lockfile. The original
 * stays where it was written: not moved, not linked over, not deleted.
 */
export async function applyImport(
  plan: ImportPlan,
  into: { registry: string; namespace: string },
): Promise<number> {
  return withScope(scopeRoots(common(plan.scope), plan.root), (loaded) =>
    copyIn(plan, loaded, into),
  );
}

async function copyIn(
  plan: ImportPlan,
  loaded: Loaded,
  into: { registry: string; namespace: string },
): Promise<number> {
  // Waiting for the lease leaves time for an edit, and the checked copy is the one imported.
  for (const artifact of plan.artifacts) {
    for (const occurrence of artifact.occurrences) {
      if ((await authoredDigest(occurrence.from)) !== artifact.digest) {
        throw new AiregError(`${quoted(artifact.name)} changed while it was being imported.`, {
          code: ErrorCode.Changed,
          hint: "Nothing was imported. Run the import again.",
        });
      }
    }
  }
  // A later `origins` step keeps this row up to date from the folder it came from.
  const lock = loaded.lock;
  // What this run copied, so a refusal part way leaves nothing behind, as its hint says.
  const made: string[] = [];
  try {
    await copyAll(plan, into, loaded, lock, made);
  } catch (error) {
    for (const copy of made) await rm(copy, { recursive: true, force: true });
    throw error;
  }
  await writeLock(loaded.roots, lock);
  return plan.artifacts.length;
}

async function copyAll(
  plan: ImportPlan,
  into: { registry: string; namespace: string },
  loaded: Loaded,
  lock: Lock,
  made: string[],
): Promise<void> {
  for (const artifact of plan.artifacts) {
    const source = artifact.occurrences[0] as Candidate;
    const copy = artifactPath(
      loaded.roots,
      into.registry,
      into.namespace,
      artifact.kind,
      artifact.name,
      artifact.artifactPath,
    );
    await guardManagedPath(copy, loaded.roots);
    if (!(await exists(copy))) made.push(copy);
    await refuseIrregular(loaded.roots, source.from, await copyAuthored(source.from, copy));
    lock.artifacts[`${into.namespace}/${artifact.name}`] = {
      registry: into.registry,
      id: undefined,
      name: artifact.name,
      kind: artifact.kind,
      namespace: into.namespace,
      address: undefined,
      content: undefined,
      version: undefined,
      path: posixRelative(loaded.roots.base, copy),
      digest: artifact.digest,
      origin: {
        target: source.target,
        path: posixRelative(loaded.roots.base, source.from),
        step: "onboarding",
      },
      links: [],
    };
  }
}
