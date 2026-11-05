import type { Scope } from "#core/store/paths.ts";
import { scopeFlag } from "#core/store/paths.ts";
import { shellWord } from "#core/term/format.ts";
import { compositeLeaves, isScopeStep, type Job, type RegistryConfig, type Step } from "./model.ts";

/** A job by id, or by the name a person typed. */
export function findJob(config: RegistryConfig, wanted: string): Job | undefined {
  return config.jobs.find((job) => job.id === wanted || job.name === wanted);
}

/** The folders a job watches and publishes from, as its folder steps store them. */
export function watchedFolders(job: Pick<Job, "steps">): string[] {
  return job.steps.flatMap((step) =>
    step.kind === "origins" ? step.select.map((selector) => selector.from) : [],
  );
}

/** The folder a job keeps in sync, as the runner reads it: its first scope step that names one. */
export function jobRoot(job: Pick<Job, "steps">): string | undefined {
  return job.steps.find((step) => isScopeStep(step) && step.root !== undefined)?.root;
}

/** What stops publishing these folders, written so a shell runs it as printed. */
export function unwatchCommand(folders: readonly string[], scope: Scope): string {
  return `aireg watch remove ${folders.map(shellWord).join(" ")}${scopeFlag(scope)}`;
}

/**
 * Replaces every composite step with the leaves it stands for, rewiring `needs`
 * so nothing outside the composite has to know it was one.
 */
export function expandSteps(steps: readonly Step[]): Step[] {
  const expanded: Step[] = [];
  // What a step name means once composites are gone: its terminal leaves.
  const terminals = new Map<string, string[]>();

  for (const step of steps) {
    const leaves = compositeLeaves(step.kind);
    if (leaves === undefined) {
      expanded.push({
        ...step,
        needs: step.needs.flatMap((name) => terminals.get(name) ?? [name]),
      });
      terminals.set(step.name, [step.name]);
      continue;
    }

    const outer = step.needs.flatMap((name) => terminals.get(name) ?? [name]);
    const names: string[] = [];
    // Every later leaf depends on the first, which is what makes `pull` gate
    // `publish` and `prune` without either of them naming the composite.
    for (const [index, kind] of leaves.entries()) {
      const name = `${step.name}/${kind}`;
      const first = names[0];
      expanded.push({
        ...step,
        name,
        kind,
        needs: index === 0 || first === undefined ? outer : [first],
      });
      names.push(name);
    }
    terminals.set(step.name, names);
  }

  return expanded;
}

/** Steps in an order that satisfies `needs`, or the cycle that prevents one. */
export function orderSteps(steps: readonly Step[]): { order: Step[] } | { cycle: string[] } {
  const byName = new Map(steps.map((step) => [step.name, step]));
  const order: Step[] = [];
  const done = new Set<string>();
  const open = new Set<string>();
  const path: string[] = [];

  const visit = (step: Step): string[] | undefined => {
    if (done.has(step.name)) return undefined;
    if (open.has(step.name)) return [...path.slice(path.indexOf(step.name)), step.name];
    open.add(step.name);
    path.push(step.name);
    for (const name of step.needs) {
      const next = byName.get(name);
      if (next === undefined) continue;
      const cycle = visit(next);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    open.delete(step.name);
    done.add(step.name);
    order.push(step);
    return undefined;
  };

  for (const step of steps) {
    const cycle = visit(step);
    if (cycle !== undefined) return { cycle };
  }
  return { order };
}
