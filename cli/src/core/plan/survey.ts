import { resolve } from "node:path";
import { dict } from "#core/fields.ts";
import { digest } from "#core/fs/digest.ts";
import { inspect } from "#core/fs/link.ts";
import { exists } from "#core/fs/tree.ts";
import { CONCURRENCY, limiter } from "#core/limit.ts";
import type { Lock } from "#core/lock.ts";
import type { Roots } from "#core/store/paths.ts";
import { artifactPath, copyLeaf } from "#core/store/paths.ts";
import type { Survey } from "./model.ts";

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
            // A copy is the harness's own; hashing it is the only way to see it edited.
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
