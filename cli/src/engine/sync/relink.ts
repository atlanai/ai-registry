import type { Plan } from "#core/plan/model.ts";

export function relinksIn(moved: ReadonlySet<string>, recording: ReadonlySet<string>): Set<string> {
  return new Set([...moved].filter((name) => !recording.has(name)));
}

/** A relink only links and drops the old link; staging, cloning and removal stay the sync's. */
export function narrowToRelinks(plan: Plan, relinks: ReadonlySet<string>): Plan {
  return {
    ...plan,
    actions: plan.actions.filter(
      (action) =>
        action.kind === "record" ||
        action.kind === "link" ||
        action.kind === "unlink" ||
        !relinks.has(action.name),
    ),
  };
}
