import { resolve } from "node:path";
import { isWithin } from "#adapter/paths.ts";
import { sanitizeText } from "#adapter/text.ts";
import type { Lock } from "#core/lock.ts";
import { NAME } from "#core/product.ts";
import { type Roots, scopeName } from "#core/store/paths.ts";
import { copyEdited, editedHere, type Survey } from "./model.ts";

/** Worst state wins per artifact, and the worst across all of them is the exit code. */
const STATES = ["ok", "missing", "dangling", "edited"] as const;

export type State = (typeof STATES)[number];

/** How one target sees an artifact; a target reached by several links takes the worst. */
export type LinkState = "linked" | "missing" | "replaced" | "foreign";

const LINK_STATES: readonly LinkState[] = ["linked", "missing", "replaced", "foreign"];

export interface ArtifactStatus {
  name: string;
  state: State;
  detail: string | undefined;
  targets: Record<string, LinkState>;
  /** A requested link that `install` cannot make while something else holds the path. */
  blocked?: true;
  /** Another artifact holds it, rather than a folder of yours. */
  taken?: true;
}

function worse(a: State, b: State): State {
  return STATES.indexOf(a) >= STATES.indexOf(b) ? a : b;
}

/** Pure: the disk was already read into `survey`. */
export function status(lock: Lock, survey: Survey, roots: Roots): ArtifactStatus[] {
  const out: ArtifactStatus[] = [];

  for (const name of Object.keys(lock.artifacts).sort()) {
    const entry = lock.artifacts[name];
    if (entry === undefined) continue;
    const state = survey.artifacts[name];

    let worst: State = "ok";
    let detail: string | undefined;

    if (state?.staged !== true) {
      worst = "missing";
      detail = `no content in ${scopeName(roots.scope)}`;
    } else if (editedHere(entry, state)) {
      worst = "edited";
      detail = "edited after installation";
    }

    const targets: Record<string, LinkState> = {};
    const see = (target: string, seen: LinkState): void => {
      const before = targets[target];
      if (before === undefined || LINK_STATES.indexOf(seen) > LINK_STATES.indexOf(before)) {
        targets[target] = seen;
      }
    };

    const ours = resolve(roots.artifacts);
    for (const link of entry.links) {
      const found = linkFinding(link, state, ours);
      if (found.state !== "ok") {
        worst = worse(worst, found.state);
        detail ??= found.detail;
      }
      see(link.target, found.seen);
    }

    const [held] = entry.blocked ?? [];
    if (held !== undefined) {
      worst = worse(worst, "missing");
      detail ??= blockedDetail(held);
      for (const each of entry.blocked ?? []) see(each.target, "missing");
    }

    out.push({
      name,
      state: worst,
      detail,
      targets,
      ...((entry.blocked?.length ?? 0) > 0 ? { blocked: true as const } : {}),
      ...(entry.blocked?.some((held) => held.by !== undefined) ? { taken: true as const } : {}),
    });
  }

  return out;
}

export function worstState(statuses: readonly ArtifactStatus[]): State {
  return statuses.reduce<State>((acc, item) => worse(acc, item.state), "ok");
}

/** What holds a path a link needed: a folder of yours, or another artifact. */
function blockedDetail(held: { target: string; path: string; by?: string | undefined }): string {
  return held.by === undefined
    ? `${held.target}: something of yours is at ${held.path}`
    : `${held.target}: ${held.by} is installed at ${held.path}`;
}

/** How one recorded link looks on disk: the state it adds, why, and what its target sees. */
function linkFinding(
  link: Lock["artifacts"][string]["links"][number],
  state: Survey["artifacts"][string] | undefined,
  ours: string,
): { state: State; detail?: string; seen: LinkState } {
  const observed = state?.links[link.path];
  if (observed?.present !== true) {
    return { state: "missing", detail: `${link.target}: not installed`, seen: "missing" };
  }
  // A copy is a real file by definition. Anywhere else a real file means the
  // link was replaced, and the target is served content we do not own.
  if (link.mode !== "copy" && !observed.isLink) {
    return {
      state: "dangling",
      detail: `${link.target}: replaced by something of yours`,
      seen: "replaced",
    };
  }
  // Every link we place points inside this scope's own tree, so a target
  // outside it is a link something else put there.
  const target = observed.target === undefined ? undefined : resolve(observed.target);
  if (target !== undefined && !isWithin(ours, target)) {
    return {
      state: "dangling",
      detail: `${link.target}: links to ${sanitizeText(target)}, not to ${NAME}'s copy`,
      seen: "foreign",
    };
  }
  if (copyEdited(link, state)) {
    return {
      state: "edited",
      detail: `${link.target}: its copy was edited after installation`,
      seen: "linked",
    };
  }
  return { state: "ok", seen: "linked" };
}
