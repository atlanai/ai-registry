import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import type { SourceAdapter } from "#adapter/index.ts";
import type { Manifest } from "#core/manifest/model.ts";
import { parseManifest } from "#core/manifest/parse.ts";
import { lock } from "#test/kit/builders/lock.ts";
import { test } from "#test/kit/fixtures.ts";
import {
  chooseTarget,
  dependsOnFor,
  type EdgeContext,
  exportWork,
  forTarget,
  inDependencyOrder,
  namesTarget,
  takenBy,
} from "./exports.ts";
import { exportsOn } from "./reach.ts";
import type { Planned, Published } from "./target.ts";
import { fromPath, type Work } from "./work.ts";

let base: string;

test.beforeEach(async ({ tmp }) => {
  base = tmp;
  for (const name of ["review", "style"]) {
    await mkdir(join(base, "skills", name), { recursive: true });
    await writeFile(
      join(base, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name}.\n---\n`,
    );
  }
  await mkdir(join(base, "agents"), { recursive: true });
  await writeFile(
    join(base, "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Reviews.\n---\nReview.\n",
  );
});

const REGISTRIES = `registries:
  acme: https://registry.example.com
  public: https://registry.example.com/
  vendor: ./vendor
artifacts:
  - public/platform/skill/sql-style@0.1.2
  - public/platform/skill/lint@2.0.0
  - acme/platform/skill/format
  - vendor/platform/skill/notes
`;

function manifestWith(exports: string, to = "acme/engineering"): Manifest {
  return parseManifest(`${REGISTRIES}exports:\n${exports}publish:\n  to: ${to}\n`);
}

async function exported(needs: string[], extra = "") {
  const manifest = manifestWith(
    `  - skills/*\n  - path: agents/reviewer.md\n    depends_on: [${needs.join(", ")}]\n${extra}`,
  );
  const { found } = await exportsOn(manifest, base);
  const works = await exportWork(found, base);
  return { manifest, found, works };
}

const named = (works: readonly Work[], name: string) =>
  works.find((work) => work.name === name) as Work;

const published = (latest: Record<string, string> = {}) =>
  ({
    alias: "acme",
    latest: new Map(Object.entries(latest).map(([key, version]) => [key, { version }])),
  }) as unknown as Published;

function context(manifest: Manifest, over: Partial<EdgeContext> = {}): EdgeContext {
  return {
    base,
    manifest,
    lock: lock()
      .registry("public", { location: "https://registry.example.com/" })
      .artifact("sql-style", { namespace: "platform", version: "0.1.2" })
      .artifact("lint", { namespace: "platform", version: "2.0.0" })
      .registry("acme", { location: "https://registry.example.com" })
      .artifact("format", { namespace: "platform", version: "0.3.2" })
      .registry("vendor", { location: "./vendor" })
      .artifact("notes", { namespace: "platform", version: "1.0.0" })
      .build(),
    known: {
      acme: { location: "https://registry.example.com", adapter: undefined, config: {} },
      public: {
        location: "https://registry.example.com/",
        adapter: undefined,
        config: {},
      },
      vendor: { location: join(base, "vendor"), adapter: undefined, config: {} },
    },
    target: { registry: "acme", namespace: "engineering" },
    published: published(),
    planned: async () => undefined,
    ...over,
  };
}

describe("exportWork", () => {
  test("refuses two exports of one kind and name, naming both paths", async () => {
    await mkdir(join(base, "vendor", "review"), { recursive: true });
    await writeFile(
      join(base, "vendor", "review", "SKILL.md"),
      "---\nname: review\ndescription: Another review.\n---\n",
    );
    const { found } = await exportsOn(manifestWith("  - skills/*\n  - vendor/review\n"), base);
    await expect(exportWork(found, base)).rejects.toMatchObject({
      message: "skills/review and vendor/review are both exported as skill review.",
      hint: "Give one of them another `name` in its front matter, or leave it out of `exports:`.",
      code: "invalid",
    });

    const kept = await exportsOn(
      manifestWith("  - skills/*\n  - path: vendor/review\n    publish: false\n"),
      base,
    );
    expect((await exportWork(kept.found, base)).map((work) => work.name)).toEqual([
      "review",
      "style",
    ]);
  });
});

describe("chooseTarget", () => {
  test("takes the manifest's target, and refuses a --to naming another", () => {
    expect(chooseTarget("acme/engineering", undefined, () => false)).toBe("acme/engineering");
    expect(chooseTarget("acme/engineering", "acme/engineering", () => true)).toBe(
      "acme/engineering",
    );
    expect(() => chooseTarget("acme/engineering", "acme/other", () => false)).toThrow(
      expect.objectContaining({
        message: '--to "acme/other" is not the manifest\'s publish target, acme/engineering.',
        hint: "Leave `--to` off to publish to acme/engineering, or change `publish.to`.",
        code: "usage",
      }),
    );
  });

  test("matches a registry as written, and a folder by where it is", () => {
    const to = { registry: "acme", namespace: "engineering", name: undefined, version: undefined };
    expect(namesTarget("acme/engineering", to, undefined, base)).toBe(true);
    expect(namesTarget("acme/other", to, undefined, base)).toBe(false);
    const folder = { ...to, registry: "../registry", namespace: "eng" };
    expect(namesTarget("./registry/eng", folder, join(base, "registry"), base)).toBe(true);
    expect(namesTarget("./registry/ops", folder, join(base, "registry"), base)).toBe(false);
    expect(namesTarget("acme/eng", folder, join(base, "registry"), base)).toBe(false);
  });
});

describe("forTarget", () => {
  test("skips an export named by its path that is never published", async () => {
    const manifest = manifestWith("  - path: skills/style\n    publish: false\n");
    const { found } = await exportsOn(manifest, base);
    expect(await exportWork(found, base)).toEqual([]);
    const path = join(base, "skills", "style");
    const style = { ...(await fromPath(path)), exported: found.get(path) };
    expect(forTarget([style], base).skipped).toEqual([
      {
        name: "style",
        kind: "skill",
        path: "skills/style",
        reason: "its export sets publish: false",
      },
    ]);
  });
});

describe("takenBy", () => {
  const adapter = (publishKinds?: readonly string[]) =>
    ({ artifactKinds: ["skill", "agent"], publishKinds }) as unknown as SourceAdapter;

  test("leaves out an export whose registry does not take its kind, and the edges to it", async () => {
    const { manifest, found, works } = await exported(
      [],
      "  - path: skills/review\n    depends_on: [./agents/reviewer.md]\n",
    );
    const taken = await takenBy(
      works,
      async () => ({ alias: "acme", adapter: adapter(["skill"]) }),
      found,
      base,
    );
    expect(taken.works.map((work) => work.name)).toEqual(["review", "style"]);
    expect(taken.skipped).toEqual([
      {
        name: "reviewer",
        kind: "agent",
        path: "agents/reviewer.md",
        reason: "acme does not take agents",
      },
    ]);
    expect(taken.warnings).toEqual([
      "Left out the dependency of review on reviewer, since acme does not take agents.",
    ]);
    const review = named(taken.works, "review");
    expect(await dependsOnFor(review, context(manifest, { left: taken.left }))).toEqual([]);

    const every = await takenBy(
      works,
      async () => ({ alias: "acme", adapter: adapter() }),
      found,
      base,
    );
    expect(every.skipped).toEqual([]);
  });

  test("leaves out a folder agent with files beyond its AGENT.md, unless the registry keeps them", async () => {
    for (const [name, files] of [
      ["helper", ["workspace/AGENTS.md", "workspace/SOUL.md"]],
      ["plain", []],
    ] as const) {
      await mkdir(join(base, "agents", name, "workspace"), { recursive: true });
      await writeFile(
        join(base, "agents", name, "AGENT.md"),
        `---\nname: ${name}\ndescription: Helps.\n---\n`,
      );
      for (const file of files) await writeFile(join(base, "agents", name, file), "Kept.\n");
    }
    const { found } = await exportsOn(manifestWith("  - agents\n"), base);
    const works = await exportWork(found, base);
    expect(works.map((work) => `${work.kind} ${work.name}`)).toEqual([
      "agent helper",
      "agent plain",
      "agent reviewer",
    ]);
    const keeping = (agentFolders: boolean) =>
      ({
        ...adapter(),
        capabilities: { agentFolders },
      }) as unknown as SourceAdapter;
    const without = await takenBy(
      works,
      async () => ({ alias: "acme", adapter: keeping(false) }),
      found,
      base,
    );
    expect(without.works.map((work) => work.name)).toEqual(["plain", "reviewer"]);
    expect(without.skipped).toEqual([
      {
        name: "helper",
        kind: "agent",
        path: "agents/helper",
        reason: "acme keeps no agent's files beyond its AGENT.md, and it has 2 more files",
      },
    ]);
    const keeps = await takenBy(
      works,
      async () => ({ alias: "acme", adapter: keeping(true) }),
      found,
      base,
    );
    expect(keeps.skipped).toEqual([]);
  });
});

describe("inDependencyOrder", () => {
  test("puts each export after the exports it depends on", async () => {
    const { found, works } = await exported(["./skills/style"]);
    const reversed = [...works].reverse();
    expect(inDependencyOrder(reversed, found, base).map((work) => work.name)).toEqual([
      "review",
      "style",
      "reviewer",
    ]);
  });

  test("refuses a cycle, naming it", async () => {
    const manifest = manifestWith(
      "  - path: agents/reviewer.md\n    depends_on: [./skills/review]\n  - path: skills/review\n    depends_on: [./agents/reviewer.md]\n",
    );
    const { found } = await exportsOn(manifest, base);
    const works = await exportWork(found, base);
    expect(() => inDependencyOrder(works, found, base)).toThrow(
      "The exports depend on each other in a cycle: ./agents/reviewer.md → ./skills/review → ./agents/reviewer.md.",
    );
  });
});

describe("dependsOnFor", () => {
  test("names another export at the version this run publishes", async () => {
    const { manifest, works } = await exported(["./skills/review"]);
    const review = named(works, "review");
    const planned = async (path: string) =>
      path === review.path ? ({ work: review, version: "0.3.2" } as Planned) : undefined;
    expect(await dependsOnFor(named(works, "reviewer"), context(manifest, { planned }))).toEqual([
      { rel_type: "depends_on", to: "engineering/skill/review@0.3.2" },
    ]);
  });

  test("names another export at the target's newest when this run leaves it out", async () => {
    const { manifest, works } = await exported(["./skills/review"]);
    const at = published({ "engineering/skill/review": "1.4.0" });
    expect(
      await dependsOnFor(named(works, "reviewer"), context(manifest, { published: at })),
    ).toEqual([{ rel_type: "depends_on", to: "engineering/skill/review@1.4.0" }]);
  });

  test("refuses another export that is not published to the target", async () => {
    const { manifest, works } = await exported(["./skills/review"]);
    await expect(dependsOnFor(named(works, "reviewer"), context(manifest))).rejects.toMatchObject({
      message: "reviewer depends on review, which is not published to acme/engineering.",
      hint: "Publish review to acme/engineering in the same run, or before it.",
    });
  });

  test("names a dependency no entry reaches, which is exported with it", async () => {
    const manifest = manifestWith(
      "  - path: agents/reviewer.md\n    depends_on: [./skills/review]\n",
    );
    const { found } = await exportsOn(manifest, base);
    const works = await exportWork(found, base);
    expect(works.map((work) => work.name)).toEqual(["reviewer", "review"]);
    const review = named(works, "review");
    const planned = async (path: string) =>
      path === review.path ? ({ work: review, version: "0.1.0" } as Planned) : undefined;
    expect(await dependsOnFor(named(works, "reviewer"), context(manifest, { planned }))).toEqual([
      { rel_type: "depends_on", to: "engineering/skill/review@0.1.0" },
    ]);
  });

  test("names the exact installed label through another alias for the same registry", async () => {
    const { manifest, works } = await exported(["public/platform/skill/sql-style"]);
    expect(await dependsOnFor(named(works, "reviewer"), context(manifest))).toEqual([
      { rel_type: "depends_on", to: "platform/skill/sql-style@0.1.2" },
    ]);
  });

  test("refuses an alias selecting a different configured registry scope", async () => {
    const { manifest, works } = await exported(["public/platform/skill/sql-style"]);
    const scoped = context(manifest);
    scoped.known = {
      ...scoped.known,
      public: { ...scoped.known.public!, config: { namespace: "other" } },
    };
    await expect(dependsOnFor(named(works, "reviewer"), scoped)).rejects.toMatchObject({
      code: "invalid",
    });
  });

  test("refuses a manifest pin that no longer matches the installed label", async () => {
    const { manifest, works } = await exported(["public/platform/skill/sql-style"]);
    manifest.artifacts = manifest.artifacts.map((ref) =>
      ref.name === "sql-style" ? { ...ref, version: "0.1.3" } : ref,
    );
    await expect(dependsOnFor(named(works, "reviewer"), context(manifest))).rejects.toMatchObject({
      code: "changed",
      hint: "Run `aireg install` to install the declared version, then publish again.",
    });
  });

  test("refuses a dependency from another registry and one that is not installed", async () => {
    const { manifest, works } = await exported(["public/platform/skill/sql-style"]);
    const other = context(manifest);
    other.known = {
      ...other.known,
      public: { location: "https://example.com/other", adapter: undefined, config: {} },
    };
    await expect(dependsOnFor(named(works, "reviewer"), other)).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      dependsOnFor(named(works, "reviewer"), context(manifest, { lock: lock().build() })),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
