import { mkdir, symlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect } from "vitest";
import type { Lock, LockArtifact } from "#core/lock.ts";
import { emptyLock } from "#core/lock.ts";
import { build } from "#core/plan/build.ts";
import type { Action, Survey } from "#core/plan/model.ts";
import { parseRef, withLocalName } from "#core/ref.ts";
import { artifactPath, roots } from "#core/store/paths.ts";
import {
  acquired,
  DRIFTED,
  entry,
  installed,
  kinds,
  kitManifest,
  LINT,
  PLAN_OPTIONS,
  SYNCED,
} from "#test/kit/builders/plan.ts";
import { test } from "#test/kit/fixtures.ts";
import { withoutKind } from "#test/kit/target.ts";

describe("build", () => {
  test("stages and links on a fresh install", () => {
    const plan = build(
      kitManifest(),
      emptyLock(),
      acquired([entry()]),
      { artifacts: {} },
      PLAN_OPTIONS,
    );
    // The mirror, this scope's copy inside the plugin, and the one link that
    // points the target at that plugin.
    expect(kinds(plan)).toEqual(["stage", "clone", "link", "record"]);
  });

  test("takes back the links an install gave a row of yours, and keeps the row", () => {
    const lock = installed();
    const origin = { target: "claude-code", path: ".claude/skills/my-lint", step: "origins" };
    lock.artifacts.lint = { ...(lock.artifacts.lint as LockArtifact), origin };
    const plan = build(kitManifest([]), lock, acquired([entry()]), SYNCED, PLAN_OPTIONS);
    const unlinked = plan.actions.flatMap((action) =>
      action.kind === "unlink" ? [relative("/work", action.to)] : [],
    );
    expect(unlinked).toEqual([join(".claude", "skills", "lint")]);
    const record = plan.actions.find((action) => action.kind === "record");
    expect(record?.kind === "record" && record.lock.artifacts.lint).toMatchObject({
      origin,
      links: [],
    });
  });

  test("never links over the folder of yours a row came from", () => {
    const lock = installed();
    const origin = { target: "claude-code", path: ".claude/skills/lint", step: "onboarding" };
    lock.artifacts.lint = { ...(lock.artifacts.lint as LockArtifact), origin, links: [] };
    const plan = build(kitManifest(), lock, acquired([entry()]), SYNCED, PLAN_OPTIONS);
    expect(plan.actions.filter((action) => action.kind === "link")).toEqual([]);
    expect(plan.warnings).toEqual([]);
    const record = plan.actions.find((action) => action.kind === "record");
    expect(record?.kind === "record" && record.lock.artifacts.lint?.links).toEqual([]);
  });

  test("keeps a row of yours on what it last sent when the registry moves, unless forced", () => {
    const lock = installed();
    const origin = { target: "claude-code", path: ".claude/skills/lint", step: "onboarding" };
    lock.artifacts.lint = { ...(lock.artifacts.lint as LockArtifact), origin, links: [] };
    const moved = acquired([entry()], "c2", new Map([["skills/lint", "sha256:t2"]]));
    const plan = build(kitManifest(), lock, moved, SYNCED, PLAN_OPTIONS);
    expect(kinds(plan)).not.toContain("stage");
    const record = plan.actions.at(-1);
    expect(record?.kind === "record" && record.lock.artifacts.lint?.content).toBe("sha256:t1");

    const forced = build(kitManifest(), lock, moved, SYNCED, { ...PLAN_OPTIONS, force: true });
    expect(kinds(forced)).toContain("stage");
  });

  test("does nothing when disk already matches", () => {
    const plan = build(kitManifest(), installed(), acquired([entry()]), SYNCED, PLAN_OPTIONS);
    expect(kinds(plan)).toEqual(["record"]);
    expect(plan.unchanged).toEqual(["lint"]);
  });

  test("restages only the path whose git object moved", () => {
    const two = [entry(), entry({ name: "review", path: "skills/review" })];
    const trees = new Map([
      ["skills/lint", "sha256:t2"],
      ["skills/review", "sha256:r1"],
    ]);
    const lock = installed();
    lock.artifacts.review = {
      registry: "kit",
      id: "skills/review",
      name: "review",
      kind: "skill",
      namespace: undefined,
      address: "skills/review",
      path: "artifacts/copy",
      origin: undefined,
      content: "sha256:r1",
      version: undefined,
      digest: "sha256:2",
      links: [{ target: "claude-code", path: ".claude/skills/review", mode: "symlink" }],
    };
    const survey: Survey = {
      artifacts: {
        lint: LINT,
        review: {
          staged: true,
          digest: "sha256:2",
          links: {
            ".claude/skills/review": {
              present: true,
              isLink: true,
              target: "/work/.registry/artifacts/kit/kit/skills/review",
              mode: "symlink",
            },
          },
        },
      },
    };
    const plan = build(
      kitManifest(["kit/skill/lint", "kit/skill/review"]),
      lock,
      acquired(two, "c2", trees),
      survey,
      PLAN_OPTIONS,
    );
    expect(plan.actions.filter((a) => a.kind === "stage").map((a) => a.name)).toEqual(["lint"]);
    expect(plan.unchanged).toEqual(["review"]);
  });

  test("keeps the revision the lock was resolved at while nothing it holds moves", () => {
    const revision = (sources: ReturnType<typeof acquired>) => {
      const record = build(kitManifest(), installed(), sources, SYNCED, PLAN_OPTIONS).actions.at(
        -1,
      );
      return record?.kind === "record" ? record.lock.registries.kit?.revision : undefined;
    };
    expect(revision(acquired([entry()], "c2"))).toBe("c1");
    // At a new address it is another source, so the old revision does not carry over.
    const moved = acquired([entry()], "c2").map((source) => ({
      ...source,
      origin: { ...source.origin, key: "sha256:elsewhere" },
    }));
    expect(revision(moved)).toBe("c2");
  });

  test("refuses new bytes under a version the lock already holds", () => {
    const lock = installed();
    const row = lock.artifacts.lint;
    if (row === undefined) throw new Error("no locked artifact");
    row.version = "1.0.0";
    const sources = acquired([entry()], "c2", new Map([["skills/lint", "sha256:t2"]]));
    sources[0]?.placements.set("skills/lint", {
      id: "skills/lint",
      name: "lint",
      contentId: "sha256:t2",
      version: "1.0.0",
    });
    const plan = build(kitManifest(), lock, sources, SYNCED, PLAN_OPTIONS);
    expect(plan.rewritten).toEqual([
      { name: "lint", version: "1.0.0", locked: "sha256:t1", served: "sha256:t2" },
    ]);
    expect(kinds(plan)).toEqual(["record"]);
  });

  test("leaves an edited copy alone, says so, and never records its digest as canonical", () => {
    const plan = build(kitManifest(), installed(), acquired([entry()]), DRIFTED, PLAN_OPTIONS);
    expect(kinds(plan)).toEqual(["record"]);
    expect(plan.warnings[0]?.hint).toMatch(/--force/);
    const record = plan.actions.at(-1);
    expect(record?.kind === "record" && record.lock.artifacts.lint?.digest).toBe("sha256:1");
  });

  test.each([
    ["project", "this project"],
    ["user", "your user scope"],
  ] as const)(
    "keeps a copy in the %s scope that the lockfile never recorded, and says where",
    (scope, said) => {
      const options = { ...PLAN_OPTIONS, roots: roots(scope, "/work") };
      const plan = build(kitManifest(), emptyLock(), acquired([entry()]), SYNCED, options);
      expect(kinds(plan)).not.toContain("stage");
      expect(plan.warnings[0]?.message).toMatch(
        new RegExp(`"lint" was already in ${said} and the lockfile did not record it`),
      );
    },
  );

  test("overwrites an edited copy under --force", () => {
    const plan = build(kitManifest(), installed(), acquired([entry()]), DRIFTED, {
      ...PLAN_OPTIONS,
      force: true,
    });
    expect(kinds(plan)).toContain("stage");
  });

  test("keeps an edited copy's lock row on the version it was edited from", () => {
    const lock = installed();
    const row = lock.artifacts.lint;
    if (row === undefined) throw new Error("no locked artifact");
    row.version = "0.1.0";
    const sources = acquired([entry()], "c2", new Map([["skills/lint", "sha256:t2"]]));
    sources[0]?.placements.set("skills/lint", {
      id: "skills/lint",
      name: "lint",
      contentId: "sha256:t2",
      version: "0.1.1",
    });
    const plan = build(kitManifest(), lock, sources, DRIFTED, PLAN_OPTIONS);
    const record = plan.actions.at(-1);
    const kept = record?.kind === "record" ? record.lock.artifacts.lint : undefined;
    expect([kept?.version, kept?.content, kept?.digest]).toEqual([
      "0.1.0",
      "sha256:t1",
      "sha256:1",
    ]);
  });

  test("keeps an edited target copy, and its lock row, on the version it was edited from", () => {
    const lock = installed();
    const row = lock.artifacts.lint;
    if (row === undefined) throw new Error("no locked artifact");
    row.version = "0.1.0";
    row.links = [
      { target: "claude-code", path: ".claude/skills/lint", mode: "copy", digest: "sha256:w" },
    ];
    const sources = acquired([entry()], "c2", new Map([["skills/lint", "sha256:t2"]]));
    sources[0]?.placements.set("skills/lint", {
      id: "skills/lint",
      name: "lint",
      contentId: "sha256:t2",
      version: "0.1.1",
    });
    const copied: Survey = {
      artifacts: {
        lint: {
          ...LINT,
          links: {
            ".claude/skills/lint": {
              present: true,
              isLink: false,
              target: undefined,
              mode: "copy",
              digest: "sha256:edited",
            },
          },
        },
      },
    };
    const plan = build(kitManifest(), lock, sources, copied, { ...PLAN_OPTIONS, copy: true });
    expect(kinds(plan)).toEqual(["record"]);
    const record = plan.actions.at(-1);
    const kept = record?.kind === "record" ? record.lock.artifacts.lint : undefined;
    expect([kept?.version, kept?.content, kept?.links[0]?.digest]).toEqual([
      "0.1.0",
      "sha256:t1",
      "sha256:w",
    ]);
    expect(plan.warnings.map((w) => w.message)).toEqual([
      expect.stringMatching(/"lint" was edited after installation/),
    ]);
  });

  test("installs an artifact under an explicit local name and records its remote identity", () => {
    const sources = acquired([entry()]);
    const source = sources[0];
    if (source === undefined) throw new Error("no source");
    source.origin = {
      adapter: "hosted",
      location: "https://registry.example",
      declared: "https://registry.example",
      key: `sha256:${"a".repeat(64)}`,
      config: {},
      revision: undefined,
    };
    source.placements.set("skills/lint", {
      id: "art_1",
      name: "lint",
      contentId: `sha256:${"b".repeat(64)}`,
      version: "1.2.0",
    });
    const aliased = kitManifest();
    aliased.artifacts = [withLocalName(parseRef("kit/skill/lint"), "work-lint")];

    const plan = build(aliased, emptyLock(), sources, { artifacts: {} }, PLAN_OPTIONS);
    const stage = plan.actions.find((action) => action.kind === "stage");
    const record = plan.actions.at(-1);

    expect(stage?.name).toBe("work-lint");
    // The mirror is upstream truth, so a local rename shows up in the
    // projection rather than in the path the bytes live at.
    expect(stage?.to).not.toContain("work-lint");
    expect(
      plan.actions.filter((action) => action.kind === "clone").map((action) => action.to),
    ).toContainEqual(expect.stringContaining("work-lint"));
    expect(record?.kind === "record" && record.lock.artifacts["work-lint"]).toMatchObject({
      registry: "kit",
      id: "art_1",
    });
  });

  test("keeps remote artifact identity and local name across a provider rename", () => {
    const sources = acquired([entry({ name: "review", path: "skills/review" })]);
    const source = sources[0];
    if (source === undefined) throw new Error("no source");
    source.origin = {
      adapter: "hosted",
      location: "https://registry.example",
      declared: "https://registry.example",
      key: `sha256:${"a".repeat(64)}`,
      config: {},
      revision: undefined,
    };
    source.placements.set("skills/review", {
      id: "art_1",
      name: "review",
      contentId: `sha256:${"c".repeat(64)}`,
      version: "1.3.0",
    });
    const previous = installed();
    previous.registries.kit = {
      location: "https://registry.example",
      adapter: "hosted",
      key: `sha256:${"a".repeat(64)}`,
      config: {},
      revision: undefined,
    };
    const old = previous.artifacts.lint;
    if (old === undefined) throw new Error("no locked artifact");
    previous.artifacts.lint = { ...old, id: "art_1", name: "lint" };

    const plan = build(kitManifest(["kit"]), previous, sources, SYNCED, PLAN_OPTIONS);
    const record = plan.actions.at(-1);
    const recorded = record?.kind === "record" ? record.lock.artifacts : {};

    // The id followed the rename, so the local name it was installed under stays.
    expect(Object.keys(recorded)).toEqual(["lint"]);
    expect(recorded.lint).toMatchObject({ id: "art_1", name: "review" });
  });

  test.each([
    ["while the registry is still fetched", () => acquired([entry()])],
    ["when the manifest asks nothing more of a registry", () => []],
  ])("removes what the manifest no longer names, through its own record only, %s", (_, sources) => {
    const plan = build(
      { ...kitManifest(), artifacts: [] },
      installed(),
      sources(),
      SYNCED,
      PLAN_OPTIONS,
    );
    // The link the target held, and this scope's copy. The mirror is shared
    // across scopes and reclaimed by `aireg cache prune`, not by this plan.
    expect(kinds(plan)).toEqual(["unlink", "unlink", "record"]);
  });

  test("keeps an edited copy nothing asks for any more, with its registry, and says so", () => {
    const plan = build(
      { ...kitManifest(), artifacts: [], registries: {} },
      installed(),
      [],
      DRIFTED,
      PLAN_OPTIONS,
    );
    expect(kinds(plan)).toEqual(["record"]);
    const record = plan.actions.at(-1);
    const lock = record?.kind === "record" ? record.lock : emptyLock();
    expect(lock.artifacts.lint).toBeDefined();
    expect(lock.registries.kit).toBeDefined();
    expect(plan.warnings).toContainEqual({
      name: "lint",
      message: expect.stringMatching(/edited after installation/),
      hint: expect.stringMatching(/--force/),
    });
  });

  test("removes an edited copy it was told to discard, or under --force, and marks it", () => {
    const copy = artifactPath(
      PLAN_OPTIONS.roots,
      "kit",
      undefined,
      "skill",
      "lint",
      "artifacts/copy",
    );
    for (const options of [
      { ...PLAN_OPTIONS, discard: new Set(["lint"]) },
      { ...PLAN_OPTIONS, force: true },
    ]) {
      const plan = build(
        { ...kitManifest(), artifacts: [] },
        installed(),
        acquired([entry()]),
        DRIFTED,
        options,
      );
      expect(kinds(plan)).toEqual(["unlink", "unlink", "record"]);
      const marked = plan.actions.flatMap((a) =>
        a.kind === "unlink" && a.edited === true ? [a.to] : [],
      );
      expect(marked).toEqual([copy]);
    }
  });

  test("leaves the links a kept copy shares with a row that goes", () => {
    const lock = installed();
    const lint = lock.artifacts.lint as LockArtifact;
    lock.artifacts.review = {
      ...lint,
      name: "review",
      path: "artifacts/review",
      digest: "sha256:r",
    };
    const survey: Survey = {
      artifacts: { ...DRIFTED.artifacts, review: { ...LINT, digest: "sha256:r" } },
    };
    const plan = build(
      { ...kitManifest(), artifacts: [], registries: {} },
      lock,
      [],
      survey,
      PLAN_OPTIONS,
    );
    const gone = plan.actions.flatMap((a) => (a.kind === "unlink" ? [a.to] : []));
    expect(gone).not.toContain(join(PLAN_OPTIONS.roots.base, ".claude/skills/lint"));
  });

  describe("a lock that points outside what aireg places", () => {
    const hostile = (links: string[], name = "lint", published = "lint"): Lock => {
      const lock = installed();
      const row = lock.artifacts.lint;
      if (row === undefined) throw new Error("fixture");
      lock.artifacts = {
        [name]: {
          ...row,
          name: published,
          links: links.map((path) => ({ target: "claude-code", path, mode: "symlink" as const })),
        },
      };
      return lock;
    };
    const unlinked = (plan: { actions: Action[] }) =>
      plan.actions.flatMap((a) => (a.kind === "unlink" ? [a.to] : []));
    const ESCAPES = [
      "../aws",
      "/home/someone/.ssh",
      ".",
      ".claude",
      ".git",
      ".claude/settings.json",
    ];

    test("never unlinks those paths for an artifact the manifest dropped", () => {
      const plan = build(
        { ...kitManifest(), artifacts: [] },
        hostile([...ESCAPES, ".claude/skills/lint"]),
        acquired([entry()]),
        { artifacts: {} },
        PLAN_OPTIONS,
      );
      expect(unlinked(plan)).toEqual([
        resolve("/work/.claude/skills/lint"),
        artifactPath(PLAN_OPTIONS.roots, "kit", undefined, "skill", "lint", "skills/lint"),
      ]);
      expect(plan.warnings.filter((w) => /Did not remove/.test(w.message))).toHaveLength(
        ESCAPES.length,
      );
    });

    test("never unlinks those paths for an artifact still installed", () => {
      const plan = build(
        kitManifest(),
        hostile(ESCAPES),
        acquired([entry()]),
        SYNCED,
        PLAN_OPTIONS,
      );
      expect(unlinked(plan)).toEqual([]);
    });

    // The checks above are on the path alone; these folders are links on disk.
    // Links to "../.." and "/" are POSIX fixtures.
    test.skipIf(process.platform === "win32")(
      "never unlinks through a target folder that is a symlink",
      async ({ tmp }) => {
        const dir = tmp;
        const project = join(dir, "proj");
        await mkdir(join(project, ".claude"), { recursive: true });
        await mkdir(join(project, ".cursor"), { recursive: true });
        await mkdir(join(dir, "victim"));
        await symlink("../..", join(project, ".claude", "skills"));
        // Cursor is not a target, so nothing this run writes goes there.
        await symlink("/", join(project, ".cursor", "skills"));
        const options = { ...PLAN_OPTIONS, roots: roots("project", project) };
        const plan = build(
          { ...kitManifest(), artifacts: [] },
          hostile([
            "../victim",
            ".claude/skills/victim",
            join(".cursor", "skills", relative("/", join(dir, "victim"))),
            join(dir, "victim"),
          ]),
          acquired([entry()]),
          { artifacts: {} },
          options,
        );
        expect(unlinked(plan)).toEqual([
          artifactPath(options.roots, "kit", undefined, "skill", "lint", "skills/lint"),
        ]);
        const refused = plan.warnings.filter((w) => /Did not remove/.test(w.message));
        expect(refused).toHaveLength(4);
        expect(refused.filter((w) => /is a symlink/.test(w.message))).toHaveLength(2);
      },
    );

    test("never writes a link through a target folder that is a symlink", async ({ tmp }) => {
      const dir = tmp;
      const project = join(dir, "proj");
      await mkdir(join(project, ".claude"), { recursive: true });
      await mkdir(join(dir, "elsewhere"));
      await symlink("../../elsewhere", join(project, ".claude", "skills"));
      const options = { ...PLAN_OPTIONS, roots: roots("project", project) };
      const plan = build(
        kitManifest(),
        emptyLock(),
        acquired([entry()]),
        { artifacts: {} },
        options,
      );
      expect(plan.actions.filter((action) => action.kind === "link")).toEqual([]);
      expect(plan.warnings.map((w) => w.message).join("\n")).toMatch(
        /Did not install lint at \.claude\/skills\/lint: \.claude\/skills is a symlink/,
      );
    });

    test("never removes a copy whose recorded name climbs out of the artifacts tree", () => {
      const plan = build(
        { ...kitManifest(), artifacts: [] },
        hostile([], "kit/lint", "../../../../../../elsewhere"),
        acquired([entry()]),
        { artifacts: {} },
        PLAN_OPTIONS,
      );
      expect(unlinked(plan)).toEqual([]);
    });
  });

  test("warns rather than guessing when a target cannot hold the kind", () => {
    const plan = build(
      kitManifest(["kit/agent/lint"]),
      emptyLock(),
      acquired([entry({ kind: "agent" })]),
      { artifacts: {} },
      {
        ...PLAN_OPTIONS,
        targets: ["codex"],
        targetTable: withoutKind(PLAN_OPTIONS.targetTable, "codex", "agent"),
      },
    );
    expect(plan.actions.filter((a) => a.kind === "link")).toHaveLength(0);
    expect(plan.warnings.some((w) => /Codex cannot load agents/.test(w.message))).toBe(true);
  });

  test("reports a reference that matches nothing", () => {
    const plan = build(
      kitManifest(["kit/skill/ghost"]),
      emptyLock(),
      acquired([entry()]),
      { artifacts: {} },
      PLAN_OPTIONS,
    );
    expect(plan.warnings[0]?.message).toMatch(/matches nothing/);
  });

  test.each([
    {
      across: "two kinds",
      entries: [entry(), entry({ name: "lint", kind: "agent", path: "agents/lint.md" })],
      refs: ["kit/skill/lint", "kit/agent/lint"],
      kept: "kit/skill/lint",
      dropped: "kit/agent/lint",
    },
    {
      across: "two namespaces",
      entries: [
        entry({ group: "ops", path: "ops/skills/lint" }),
        entry({ group: "eng", path: "eng/skills/lint" }),
      ],
      refs: ["kit/ops/skill/lint", "kit/eng/skill/lint"],
      kept: "kit/ops/skill/lint",
      dropped: "kit/eng/skill/lint",
    },
  ])("says when $across would install under one name", ({ entries, refs, kept, dropped }) => {
    const plan = build(
      kitManifest(refs),
      emptyLock(),
      acquired(entries),
      { artifacts: {} },
      PLAN_OPTIONS,
    );
    expect(plan.clashes).toEqual([{ name: "lint", kept, dropped }]);
    // A command says what it did about each clash; the plan only records it.
    expect(plan.warnings).toEqual([]);
  });

  test("resolves an address without its kind to the one artifact of that name", () => {
    const plan = build(
      kitManifest(["kit/sales/lint"]),
      emptyLock(),
      acquired([entry({ group: "sales" })]),
      { artifacts: {} },
      PLAN_OPTIONS,
    );
    expect(plan.actions.some((a) => a.kind === "link" && a.name === "lint")).toBe(true);
  });

  test("refuses an address without its kind when two kinds share the name", () => {
    const plan = build(
      kitManifest(["kit/sales/lint"]),
      emptyLock(),
      acquired([
        entry({ group: "sales" }),
        entry({ group: "sales", kind: "agent", path: "agents/lint.md" }),
      ]),
      { artifacts: {} },
      PLAN_OPTIONS,
    );
    expect(plan.actions.filter((a) => a.kind === "link")).toHaveLength(0);
    expect(
      plan.warnings.some((w) =>
        w.message.includes("kit/sales/agent/lint and kit/sales/skill/lint. Name one of them."),
      ),
    ).toBe(true);
  });

  test("installs a plugin as a unit instead of its own leaves twice", () => {
    const entries = [
      entry({ name: "toolkit", kind: "plugin", path: "plugins/toolkit", group: undefined }),
      entry({ name: "format", path: "plugins/toolkit/skills/format", group: "toolkit" }),
    ];
    const plan = build(
      kitManifest(["kit"]),
      emptyLock(),
      acquired(entries),
      { artifacts: {} },
      PLAN_OPTIONS,
    );
    const staged = plan.actions.filter((a) => a.kind === "stage").map((a) => a.name);
    expect(staged).toEqual(["toolkit"]);
  });
});
