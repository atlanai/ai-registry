import type { Entry } from "#core/catalog/model.ts";
import { resolveHarnesses } from "#core/harness/index.ts";
import type { Lock } from "#core/lock.ts";
import type { Manifest } from "#core/manifest.ts";
import type { BuildOptions } from "#core/plan/build.ts";
import type {
  Acquired,
  Action,
  ArtifactSurvey,
  Placement,
  Plan,
  Survey,
} from "#core/plan/model.ts";
import { roots } from "#core/store/paths.ts";
import { lock } from "./lock.ts";
import { manifest } from "./manifest.ts";

/** The one registry the planner tests read, a git checkout at `/snap`. */
const KIT = "https://github.com/acme/kit.git";

/** A project at `/work` projecting into Claude Code. */
export const PLAN_OPTIONS: BuildOptions = {
  roots: roots("project", "/work"),
  targets: ["claude"],
  harnesses: resolveHarnesses(),
  force: false,
  copy: false,
};

/** A catalog entry for `skills/lint` unless overridden. */
export function entry(over: Partial<Entry> = {}): Entry {
  return {
    name: "lint",
    kind: "skill",
    path: "skills/lint",
    group: undefined,
    description: undefined,
    engine: undefined,
    from: { file: "skills/lint/SKILL.md", pointer: "" },
    ...over,
  };
}

/** `kit` opened at `revision`, placing each entry with its content id from `contents`. */
export function acquired(
  entries: Entry[],
  revision = "c1",
  contents = new Map([["skills/lint", "sha256:t1"]]),
): Acquired[] {
  const placements = new Map<string, Placement>();
  for (const item of entries) {
    placements.set(item.path, {
      id: item.path,
      name: item.name,
      contentId: contents.get(item.path),
      version: undefined,
    });
  }
  return [
    {
      alias: "kit",
      origin: {
        adapter: "git",
        location: KIT,
        declared: KIT,
        key: "sha256:kit",
        config: {},
        revision,
      },
      placements,
      catalog: { root: "/snap", layouts: ["plugin"], entries, warnings: [] },
      content: (path) =>
        Promise.resolve({
          path: path === "" ? "/snap" : `/snap/${path}`,
          root: "/snap",
          contentId: "sha256:t1",
          dropped: [],
          envelope: {
            apiVersion: "aireg.sh/v1",
            kind: "skill",
            metadata: { name: "lint" },
            files: [],
          },
        }),
      close: () => Promise.resolve(),
    },
  ];
}

/** A manifest that declares `kit` and asks for `refs` from it. */
export function kitManifest(refs = ["kit/skill/lint"]): Manifest {
  return manifest()
    .registry("kit", KIT)
    .artifacts(...refs)
    .build();
}

/** A lock holding `lint` from `kit` at revision `c1`, linked into Claude Code. */
export function installed(over: { digest?: string; content?: string } = {}): Lock {
  return lock()
    .registry("kit", { location: KIT, adapter: "git", key: "sha256:kit", revision: "c1" })
    .artifact("lint", {
      id: "skills/lint",
      address: "skills/lint",
      path: "artifacts/copy",
      content: over.content ?? "sha256:t1",
      digest: over.digest ?? "sha256:1",
      links: [{ harness: "claude", path: ".claude/skills/lint", mode: "symlink" }],
    })
    .build();
}

/** The disk as `installed()` left it. */
export const LINT: ArtifactSurvey = {
  staged: true,
  digest: "sha256:1",
  links: {
    ".claude/skills/lint": {
      present: true,
      isLink: true,
      target: "/work/.registry/artifacts/kit/kit/skills/lint",
      mode: "symlink",
    },
  },
};

export const SYNCED: Survey = { artifacts: { lint: LINT } };

/** `lint` edited in place since it was installed. */
export const DRIFTED: Survey = {
  artifacts: { lint: { ...LINT, digest: "sha256:edited" } },
};

export const kinds = (plan: { actions: Action[] }) => plan.actions.map((a) => a.kind);

/** Where a plan links one harness, sorted. */
export function linksTo(actions: readonly Action[], target: string): string[] {
  return actions
    .filter((action): action is Extract<Action, { kind: "link" }> => action.kind === "link")
    .filter((action) => action.harness === target)
    .map((action) => action.to)
    .sort();
}

/** The same sources, read through an adapter that declares each namespace a plugin. */
export function wrapping(sources: readonly Acquired[]): Acquired[] {
  return sources.map((source) => ({ ...source, namespacePlugins: true }));
}

/** A plugin and the two artifacts it holds, as a registry publishes them. */
export function pluginCatalog(name = "toolkit"): Entry[] {
  return [
    entry({ name, kind: "plugin", path: `plugins/${name}`, group: undefined }),
    entry({ name: "fmt", kind: "skill", path: `plugins/${name}/skills/fmt`, group: name }),
    entry({
      name: "ship",
      kind: "agent",
      path: `plugins/${name}/agents/ship.md`,
      group: name,
    }),
  ];
}

/** The content id `kit` places the toolkit plugin at. */
export const PLUGIN_TREES = new Map([["plugins/toolkit", "tp"]]);

/** A plan with nothing in it, for a test to add the actions it applies. */
export function emptyPlan(): Plan {
  return {
    actions: [],
    unchanged: [],
    warnings: [],
    incompatible: [],
    rewritten: [],
    clashes: [],
    renamed: [],
    neededBy: {},
    pruned: [],
    unresolved: [],
    withheld: [],
    unlisted: [],
    untrusted: [],
    conflicts: [],
  };
}
