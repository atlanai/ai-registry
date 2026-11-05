import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import type { Lock } from "#core/lock.ts";
import type { ArtifactStatus } from "#core/plan/status.ts";
import type { Survey } from "#core/plan/survey.ts";
import { roots as makeRoots } from "#core/store/paths.ts";
import { lock as lockOf } from "#test/kit/builders/lock.ts";
import { test } from "#test/kit/fixtures.ts";
import { groupArtifacts, health, publishable, selector, summarize } from "./artifacts.ts";
import { flatten } from "./flatten.ts";
import { type ArtifactGroup, emptyCounts, LOCAL_GROUP } from "./model.ts";

let home: string;

test.beforeAll(async ({ fileTmp }) => {
  home = fileTmp;
  await mkdir(join(home, ".registry"), { recursive: true });
});

function lockWith(): Lock {
  const built = lockOf().registry("market", {
    location: "https://api.acme.example",
    adapter: "acme",
    key: "sha256:k",
  });
  for (const [key, namespace, version] of [
    ["eng/lint", "eng", "0.1.0"],
    ["eng/format", "eng", "0.1.0"],
    ["mine/audit", "mine", "1"],
  ] as const) {
    built.artifact(key, {
      id: `skill_${key}`,
      namespace,
      path: `${key}/SKILL.md`,
      content: "sha256:c",
      version,
      digest: "sha256:lock",
      links: [{ target: "claude-code", path: `.claude/skills/${namespace}`, mode: "symlink" }],
    });
  }
  return built.build();
}

function surveyWith(digests: Record<string, string>): Survey {
  const artifacts: Survey["artifacts"] = {};
  for (const [key, digest] of Object.entries(digests)) {
    artifacts[key] = {
      staged: true,
      digest,
      links: {
        [`.claude/skills/${key.split("/")[0]}`]: {
          present: true,
          isLink: true,
          target: "/somewhere",
          mode: "symlink",
        },
      },
    };
  }
  return { artifacts };
}

const STATUSES: ArtifactStatus[] = [
  { name: "eng/lint", state: "ok", detail: undefined, targets: {} },
  { name: "eng/format", state: "ok", detail: undefined, targets: {} },
  { name: "mine/audit", state: "edited", detail: "edited after installation", targets: {} },
];

async function build(
  failed: Map<string, string>,
  pending: Set<string>,
  local: Parameters<typeof groupArtifacts>[0]["local"] = [],
) {
  return groupArtifacts({
    lock: lockWith(),
    survey: surveyWith({
      "eng/lint": "sha256:lock",
      "eng/format": "sha256:lock",
      "mine/audit": "sha256:mine",
    }),
    statuses: STATUSES,
    roots: makeRoots("user", home, { ...process.env, AIREG_HOME: join(home, ".registry") }),
    upstream: { failed, pending },
    defaultNamespace: "mine",
    local,
  });
}

describe("groupArtifacts", () => {
  test("groups by namespace and marks the one a publish defaults to", async () => {
    const groups = await build(new Map(), new Set());
    expect(groups.map((group) => group.key)).toEqual(["eng", "mine"]);
    expect(groups.find((group) => group.key === "mine")?.isDefault).toBe(true);
  });

  test("lists an artifact the registry refused, which is in no lock", async () => {
    const groups = await build(new Map([["eng/ghost", "HTTP 404"]]), new Set());
    const eng = groups.find((group) => group.key === "eng");
    expect(eng?.counts.failed).toBe(1);
    // Trouble sorts first, so what you can act on is never scrolled to.
    expect(eng?.rows[0]?.name).toBe("ghost");
    expect(eng?.rows[0]?.detail).toBe("HTTP 404");
  });

  test("does not count a refusal as an import", async () => {
    const groups = await build(new Map([["eng/ghost", "HTTP 404"]]), new Set());
    expect(summarize(groups, 4)).toMatchObject({
      skillsImported: 3,
      skillsExamined: 4,
      failed: 1,
      edited: 1,
    });
  });

  test("lets what upstream says outrank what the disk says", async () => {
    const groups = await build(new Map(), new Set(["mine/audit"]));
    const row = groups.find((group) => group.key === "mine")?.rows[0];
    expect(row?.state).toBe("pending");
  });

  test("offers only an edited artifact for publishing", async () => {
    const groups = await build(new Map(), new Set());
    expect(publishable(groups[0] as never)).toEqual([]);
    const mine = groups.find((group) => group.key === "mine");
    expect(publishable(mine as never).map(selector)).toEqual(["audit"]);
  });

  test("does not offer local work whose name a registry already publishes", async () => {
    // `publish` calls that undeclared and refuses it; offering it is a promise
    // the console cannot keep.
    const groups = await build(new Map(), new Set(), [
      {
        key: "lint",
        name: "lint",
        kind: "skill",
        registry: "local",
        namespace: undefined,
        id: "",
        version: undefined,
        lockDigest: "",
        diskDigest: undefined,
        state: "duplicate",
        detail: "a registry already publishes this name",
        targets: ["claude-code"],
        copy: "/home/.claude/skills/lint",
        changedAtMs: undefined,
        links: [],
      },
    ]);
    const last = groups.at(-1);
    expect(last?.counts.duplicate).toBe(1);
    expect(publishable(last as never)).toEqual([]);
    expect(summarize(groups, 4).skillsImported).toBe(3);
  });

  test("puts work authored here in its own group, last", async () => {
    const groups = await build(new Map(), new Set(), [
      {
        key: "notes",
        name: "notes",
        kind: "skill",
        registry: "local",
        namespace: undefined,
        id: "",
        version: undefined,
        lockDigest: "",
        diskDigest: undefined,
        state: "unpublished",
        detail: undefined,
        targets: ["claude-code"],
        copy: "/home/.claude/skills/notes",
        changedAtMs: undefined,
        links: [],
      },
    ]);
    const last = groups.at(-1);
    expect(last?.key).toBe(LOCAL_GROUP);
    expect(last?.label).toBe("THIS MACHINE");
    // Local work was written here, not imported from anywhere.
    expect(summarize(groups, 4).skillsImported).toBe(3);
    expect(summarize(groups, 4).unpublished).toBe(1);
  });

  test("names the target each link feeds, not the folder it lives in", async () => {
    const lock = lockWith();
    for (const entry of Object.values(lock.artifacts)) {
      entry.links = [{ target: "codex", path: ".agents/skills/eng", mode: "symlink" }];
    }
    const groups = await groupArtifacts({
      lock,
      survey: surveyWith({}),
      statuses: STATUSES,
      roots: makeRoots("user", home, { ...process.env, AIREG_HOME: join(home, ".registry") }),
      upstream: { failed: new Map(), pending: new Set() },
      defaultNamespace: "mine",
      local: [],
    });
    expect(groups[0]?.rows[0]?.targets).toEqual(["codex"]);
  });

  test("treats a registry the user aliased local like any other", async () => {
    const lock = lockWith();
    lock.registries.local = lock.registries.market as Lock["registries"][string];
    for (const entry of Object.values(lock.artifacts)) entry.registry = "local";
    const groups = await groupArtifacts({
      lock,
      survey: surveyWith({ "eng/lint": "sha256:lock" }),
      statuses: STATUSES,
      roots: makeRoots("user", home, { ...process.env, AIREG_HOME: join(home, ".registry") }),
      upstream: { failed: new Map(), pending: new Set() },
      defaultNamespace: "mine",
      local: [],
    });
    const lint = groups.flatMap((group) => group.rows).find((row) => row.key === "eng/lint");
    expect(lint).toMatchObject({ state: "ok", namespace: "eng" });
  });

  test("counts a version spread commonest first", async () => {
    const groups = await build(new Map(), new Set());
    expect(groups.find((group) => group.key === "eng")?.versions).toEqual(["0.1.0 x2"]);
  });
});

describe("flatten", () => {
  test("hides a folded group's members but keeps its header", async () => {
    const groups = await build(new Map(), new Set());
    const open = flatten(groups, { folded: new Set(), filter: "", only: undefined });
    const shut = flatten(groups, { folded: new Set(["eng"]), filter: "", only: undefined });
    expect(open.lines).toHaveLength(5);
    expect(shut.lines).toHaveLength(3);
  });

  test("drops a group a filter matches nothing in, and ignores folding", async () => {
    const groups = await build(new Map(), new Set());
    const found = flatten(groups, { folded: new Set(["mine"]), filter: "audit", only: undefined });
    expect(
      found.lines.map((line) => (line.kind === "group" ? line.group.key : line.row.key)),
    ).toEqual(["mine", "mine/audit"]);
    expect(found.shown).toBe(1);
  });

  test("filters on the state word, which is how you find your own edits", async () => {
    const groups = await build(new Map(), new Set());
    const found = flatten(groups, { folded: new Set(), filter: "edited", only: undefined });
    expect(found.shown).toBe(1);
  });
});

describe("selector", () => {
  test("hands publish the leaf, because a lock key is not a name", () => {
    expect(selector({ key: "eng/lint" } as never)).toBe("lint");
    expect(selector({ key: "lint" } as never)).toBe("lint");
  });

  test("hands publish the folder of work authored here, even when a job already carries it", () => {
    expect(selector({ key: "notes", state: "imported", copy: "/s/notes" } as never)).toBe(
      "/s/notes",
    );
  });
});

describe("publishable", () => {
  test("leaves out what a job already carries, so publish all sends only work never sent", () => {
    const rows = [
      { key: "a", state: "imported" },
      { key: "b", state: "unpublished" },
    ];
    expect(publishable({ rows } as never).map((row) => row.key)).toEqual(["b"]);
  });

  test("leaves out local work a job carries, which that job sends rather than a publish", () => {
    const row = (name: string, state: "edited" | "unpublished", carriedBy?: string) =>
      ({ name, key: name, state, carriedBy }) as unknown as ArtifactGroup["rows"][number];
    const group = {
      key: LOCAL_GROUP,
      label: "this machine",
      isDefault: false,
      authoredHere: true,
      rows: [row("carried", "edited", "job_import"), row("new", "unpublished")],
      counts: { ...emptyCounts(), edited: 1, unpublished: 1 },
      versions: [],
    } as ArtifactGroup;
    expect(publishable(group).map((each) => each.name)).toEqual(["new"]);
  });
});

describe("health", () => {
  function group(counts: Partial<ReturnType<typeof emptyCounts>>): ArtifactGroup {
    const all = { ...emptyCounts(), ...counts };
    const size = Object.values(all).reduce((sum, count) => sum + count, 0);
    return {
      key: LOCAL_GROUP,
      label: "this machine",
      isDefault: false,
      authoredHere: true,
      rows: Array.from({ length: size }) as ArtifactGroup["rows"],
      counts: all,
      versions: [],
    };
  }

  test("counts local work a job carries as settled, and reports what is not beside it", () => {
    expect(health(group({ imported: 2, unpublished: 1, ok: 3 }))).toEqual({
      settled: 5,
      trouble: ["1 unpublished"],
    });
  });
});
