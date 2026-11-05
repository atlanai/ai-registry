import { copyDescribed, reasonOf } from "#core/adapter/materialize.ts";
import { digest } from "#core/fs/digest.ts";
import { exists, remove, unseal } from "#core/fs/tree.ts";
import type { Action, Fetch, Plan, Staged } from "#core/plan/model.ts";
import { assertManagedPath } from "#core/store/managed-paths.ts";
import { type ActionOf, type Cloned, type Run, type Staging, stageKey } from "./run.ts";

/** Enough to keep the transport busy; few enough that a failure stops the rest. */
const AHEAD = 24;

/** Fetches ahead of the loop, which still copies in plan order. */
export function prefetch(
  plan: Plan,
  fetch: Fetch,
): (source: string, path: string) => Promise<Staged> {
  const stages = plan.actions.filter((action) => action.kind === "stage");
  const started = new Map<string, Promise<Staged>>();
  let next = 0;
  let taken = 0;

  const fill = (): void => {
    while (next < stages.length && next - taken < AHEAD) {
      const action = stages[next++] as Extract<Action, { kind: "stage" }>;
      const key = stageKey(action.source, action.path);
      if (started.has(key)) continue;

      const pending = fetch(action.source, action.path);
      // Reported where it is awaited.
      pending.catch(() => {});

      started.set(key, pending);
    }
  };

  fill();
  return (source, path) => {
    taken += 1;
    fill();
    return started.get(stageKey(source, path)) ?? fetch(source, path);
  };
}

export async function stage(run: Run, action: ActionOf<"stage">): Promise<Staging> {
  // One artifact the source cannot serve intact must not cost a person the
  // other twenty; clone, link and record already skip what was never staged.
  let from: Staged;
  try {
    // The only place bytes are waited for; a dry run never reaches here.
    from = await run.inputs.ahead(action.source, action.path);
  } catch (error) {
    await assertManagedPath(action.to, run.inputs.roots, { leaf: false, env: run.inputs.env });
    await remove(action.to);
    return { staged: undefined, unstaged: [[action.name, { reason: reasonOf(error), error }]] };
  }
  // A collection that lost a member still installs, so say which member and why.
  const unstaged = from.dropped.map(({ member, reason, error }): Staging["unstaged"][number] => [
    `${action.name}/${member}`,
    { reason, error },
  ]);
  return { staged: from, unstaged };
}

export async function cloneInto(run: Run, action: ActionOf<"clone">): Promise<Cloned> {
  const { staged, digests } = run.results;
  // Only bytes this run staged and checked are copied; a stage that failed left none.
  const from = staged.get(action.name);
  if (from === undefined || !(await exists(from.path))) return { cloned: false };
  await remove(action.to);
  // Only what the envelope describes lands, whatever else sits beside it.
  await copyDescribed(from, action.to);
  // This copy is the one a person is allowed to edit.
  await unseal(action.to);
  // The lock describes the copy, not the root: a file-shaped kind is a
  // directory upstream and a single file here, and the two never hash alike.
  const first = !digests.has(action.name);
  return { cloned: true, digest: first ? await digest(action.to) : undefined };
}
