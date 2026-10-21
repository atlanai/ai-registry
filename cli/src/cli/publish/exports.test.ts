import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { type Manifest, parseManifest } from "#core/manifest.ts";
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
  acme: github.com/acme/agent-registry
  public: https://github.com/acme/public-registry.git
  vendor: ./vendor
artifacts:
  - public/platform/skill/sql-style@^1.2
  - public/platform/skill/lint@2.0.0
  - acme/platform/skill/format
  - vendor/platform/skill/notes
`;

function manifestWith(exports: string, to = "acme/engineering"): Manifest {
  return parseManifest(`${REGISTRIES}exports:\n${exports}publish:\n  to: ${to}\n`);
}

/** The exports of a manifest whose agent depends on whatever `needs` lists. */
async function exported(needs: string[], extra = "") {
  const manifest = manifestWith(
    `  - skills/*\n  - path: agents/reviewer.md\n    depends_on: [${needs.join(", ")}]\n${extra}`,
  );
  const { found } = await exportsOn(manifest, base);
  const works = await exportWork(found);
  return { manifest, found, works };
}

const named = (works: readonly Work[], name: string) =>
  works.find((work) => work.name === name) as Work;

const published = (latest: Record<string, string> = {}) =>
  ({
    alias: "acme",
    latest: new Map(Object.entries(latest).map(([key, version]) => [key, { version }])),
  }) as unknown as Published;

function context(
  found: EdgeContext["found"],
  manifest: Manifest,
  over: Partial<EdgeContext> = {},
): EdgeContext {
  return {
    base,
    found,
    manifest,
    lock: lock()
      .registry("public", { location: "https://github.com/acme/public-registry.git" })
      .artifact("sql-style", { namespace: "platform", version: "1.4.0" })
      .artifact("lint", { namespace: "platform", version: "2.0.0" })
      .registry("acme", { location: "github.com/acme/agent-registry" })
      .artifact("format", { namespace: "platform", version: "0.3.2" })
      .registry("vendor", { location: "./vendor" })
      .artifact("notes", { namespace: "platform", version: "1.0.0" })
      .build(),
    known: {
      acme: { location: "github.com/acme/agent-registry", adapter: undefined, config: {} },
      public: {
        location: "https://github.com/acme/public-registry.git",
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
    expect(await exportWork(found)).toEqual([]);
    const path = join(base, "skills", "style");
    const style = { ...(await fromPath(path)), exported: found.get(path) };
    expect(forTarget([style]).skipped).toEqual([
      { name: "style", kind: "skill", reason: "its export sets publish: false" },
    ]);
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
    const works = await exportWork(found);
    expect(() => inDependencyOrder(works, found, base)).toThrow(
      "The exports depend on each other in a cycle: ./agents/reviewer.md → ./skills/review → ./agents/reviewer.md.",
    );
  });
});

describe("dependsOnFor", () => {
  test("names another export at the version this run publishes", async () => {
    const { manifest, found, works } = await exported(["./skills/review"]);
    const review = named(works, "review");
    const planned = async (path: string) =>
      path === review.path ? ({ work: review, version: "0.3.2" } as Planned) : undefined;
    expect(
      await dependsOnFor(named(works, "reviewer"), context(found, manifest, { planned })),
    ).toEqual([{ rel_type: "depends_on", to: "engineering/skill/review@0.3.2", range: "^0.3.2" }]);
  });

  test("names another export at the target's newest when this run leaves it out", async () => {
    const { manifest, found, works } = await exported(["./skills/review"]);
    const at = published({ "engineering/skill/review": "1.4.0" });
    expect(
      await dependsOnFor(named(works, "reviewer"), context(found, manifest, { published: at })),
    ).toEqual([{ rel_type: "depends_on", to: "engineering/skill/review@1.4.0", range: "^1.4.0" }]);
  });

  test("refuses another export that is not published to the target", async () => {
    const { manifest, found, works } = await exported(["./skills/review"]);
    await expect(
      dependsOnFor(named(works, "reviewer"), context(found, manifest)),
    ).rejects.toMatchObject({
      message: "reviewer depends on review, which is not published to acme/engineering.",
      hint: "Publish review to acme/engineering in the same run, or before it.",
    });
    // An export kept here is told what keeps it.
    const kept = await exported(
      ["./skills/review"],
      "  - path: skills/review\n    publish: false\n",
    );
    await expect(
      dependsOnFor(named(kept.works, "reviewer"), context(kept.found, kept.manifest)),
    ).rejects.toMatchObject({
      hint: 'Remove `publish: false` from export "skills/review", so review is published with it.',
    });
  });

  test("refuses a path that is no export", async () => {
    const manifest = manifestWith(
      "  - path: agents/reviewer.md\n    depends_on: [./skills/review]\n",
    );
    const { found } = await exportsOn(manifest, base);
    const [reviewer] = await exportWork(found);
    await expect(dependsOnFor(reviewer as Work, context(found, manifest))).rejects.toThrow(
      "reviewer depends on ./skills/review, which is not an export.",
    );
  });

  test("names an installed artifact at its locked version, taking what its entry takes", async () => {
    const { manifest, found, works } = await exported([
      "public/platform/skill/sql-style",
      "public/platform/skill/lint",
      "acme/platform/skill/format",
    ]);
    expect(await dependsOnFor(named(works, "reviewer"), context(found, manifest))).toEqual([
      {
        rel_type: "depends_on",
        to: "platform/skill/sql-style@1.4.0",
        range: "^1.2",
        registry: "https://github.com/acme/public-registry",
      },
      {
        rel_type: "depends_on",
        to: "platform/skill/lint@2.0.0",
        registry: "https://github.com/acme/public-registry",
      },
      // In the registry it is published to, so no `registry`; unpinned, so its releases.
      { rel_type: "depends_on", to: "platform/skill/format@0.3.2", range: "^0.3.2" },
    ]);
  });

  test("leaves out `registry` for a folder that is the same registry as the target", async () => {
    const { manifest, found, works } = await exported(["vendor/platform/skill/notes"]);
    const edges = context(found, manifest, {
      target: { registry: "./vendor", namespace: "eng" },
    });
    edges.known = {
      ...edges.known,
      "./vendor": { location: join(base, "vendor/"), adapter: "local", config: {} },
    };
    expect(await dependsOnFor(named(works, "reviewer"), edges)).toEqual([
      { rel_type: "depends_on", to: "platform/skill/notes@1.0.0", range: "^1.0.0" },
    ]);
  });

  /** The `vendor` folder as a registry whose registry.json names `url`. */
  const writeVendor = async (url: string) => {
    await mkdir(join(base, "vendor"), { recursive: true });
    const document = { kind: "registry", format_version: 1, name: "vendor", url };
    await writeFile(join(base, "vendor", "registry.json"), JSON.stringify(document));
  };

  test("names a folder registry by the https url its registry.json names", async () => {
    // The URL a project declaring this folder matches the edge by.
    await writeVendor("https://GitHub.com/acme/vendor-registry.git/");
    const { manifest, found, works } = await exported(["vendor/platform/skill/notes"]);
    expect(await dependsOnFor(named(works, "reviewer"), context(found, manifest))).toEqual([
      {
        rel_type: "depends_on",
        to: "platform/skill/notes@1.0.0",
        range: "^1.0.0",
        registry: "https://github.com/acme/vendor-registry",
      },
    ]);
  });

  test("refuses a registry with no https address, and an artifact not installed", async () => {
    const { manifest, found, works } = await exported(["vendor/platform/skill/notes"]);
    const reviewer = named(works, "reviewer");
    await expect(dependsOnFor(reviewer, context(found, manifest))).rejects.toMatchObject({
      message:
        "reviewer depends on notes from vendor, which has no https address, so a published artifact cannot name it.",
      code: "invalid",
    });
    // A folder whose registry.json names a URL that is not https is refused all the same.
    await writeVendor("http://github.com/acme/vendor-registry");
    await expect(dependsOnFor(reviewer, context(found, manifest))).rejects.toMatchObject({
      code: "invalid",
    });
    const bare = context(found, manifest, { lock: lock().build() });
    await expect(dependsOnFor(reviewer, bare)).rejects.toMatchObject({
      message: "reviewer depends on vendor/platform/skill/notes, which is not installed.",
      hint: "Run `aireg install` to install it, then publish again.",
      code: "not_found",
    });
  });
});
