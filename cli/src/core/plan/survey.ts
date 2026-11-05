import { resolve } from "node:path";
import { CONCURRENCY, limiter } from "#core/concurrency.ts";
import { dict } from "#core/fields.ts";
import { digest } from "#core/fs/digest.ts";
import { inspect } from "#core/fs/link.ts";
import { exists } from "#core/fs/tree.ts";
import type { LinkMode, Lock, LockArtifact } from "#core/lock.ts";
import type { Roots } from "#core/store/paths.ts";
import { artifactPath, copyLeaf } from "#core/store/paths.ts";

/**
 * The only reader of installed state. Keeping it in one place is what lets
 * `build` and `status` stay pure functions of values.
 */
export async function survey(lock: Lock, roots: Roots): Promise<Survey> {
  const artifacts: Survey["artifacts"] = dict();
  // Each artifact walks and hashes its copies; hundreds at once would hold a
  // read stream per file and run out of descriptors.
  const bounded = limiter(CONCURRENCY);

  await Promise.all(
    Object.entries(lock.artifacts).map(([name, entry]) =>
      bounded(async () => {
        const links: Survey["artifacts"][string]["links"] = {};
        await Promise.all(
          entry.links.map(async (link) => {
            const full = resolve(roots.base, link.path);
            const state = await inspect(full);
            // A copy is the target's own; hashing it is the only way to see it edited.
            const copied = link.mode === "copy" && state.exists && !state.isLink;
            links[link.path] = {
              present: state.exists,
              isLink: state.isLink,
              target: state.target,
              mode: link.mode,
              ...(copied ? { digest: await digest(full, link.digest) } : {}),
            };
          }),
        );

        // An edit is this scope's copy against what was installed.
        const copy = artifactPath(
          roots,
          entry.registry,
          entry.namespace,
          entry.kind,
          copyLeaf(name, entry.name),
          entry.path,
        );
        const present = await exists(copy);

        artifacts[name] = {
          staged: present,
          digest: present ? await digest(copy, entry.digest) : undefined,
          links,
        };
      }),
    ),
  );

  return { artifacts };
}

export interface ArtifactSurvey {
  /** Present in this scope's writable copy. */
  staged: boolean;
  /** Undefined when nothing is staged. */
  digest: string | undefined;
  links: Record<
    string,
    {
      present: boolean;
      isLink: boolean;
      target: string | undefined;
      mode: LinkMode;
      /** A copy's digest now, compared with the one the lock recorded. */
      digest?: string | undefined;
    }
  >;
}

export interface Survey {
  artifacts: Record<string, ArtifactSurvey>;
}

/** A target's copy that no longer matches what was written there. */
export function copyEdited(
  link: { path: string; mode: LinkMode; digest?: string | undefined },
  state: ArtifactSurvey | undefined,
): boolean {
  const seen = state?.links[link.path];
  return (
    link.mode === "copy" &&
    link.digest !== undefined &&
    seen?.digest !== undefined &&
    seen.digest !== link.digest
  );
}

/** The copy here no longer matches what the lock says was installed. */
export function editedHere(
  entry: LockArtifact | undefined,
  state: ArtifactSurvey | undefined,
): boolean {
  return (
    state?.staged === true &&
    entry !== undefined &&
    entry.digest !== "" &&
    state.digest !== entry.digest
  );
}

/** Edited in this scope's copy or in a target's own copy, so not ours to replace unasked. */
export function editedAnywhere(
  entry: LockArtifact | undefined,
  state: ArtifactSurvey | undefined,
): boolean {
  return editedHere(entry, state) || (entry?.links ?? []).some((link) => copyEdited(link, state));
}
