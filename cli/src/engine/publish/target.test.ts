import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { offerFrom } from "#core/filespec/offer.ts";
import { test } from "#test/kit/fixtures.ts";
import { commitAndPush, type Published, parseTo, plan } from "./target.ts";
import type { Work } from "./work.ts";

vi.mock("#core/filespec/offer.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#core/filespec/offer.ts")>();
  return { ...actual, offerFrom: vi.fn(actual.offerFrom) };
});

let root: string;

test.beforeEach(async ({ tmp }) => {
  root = tmp;
  vi.mocked(offerFrom).mockClear();
});

describe("plan", () => {
  test("reads an edited artifact's files once, even when the version moves", async () => {
    const path = join(root, "lint");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), "---\nname: lint\ndescription: Lints code.\n---\n");
    await writeFile(join(path, "model.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x81]));
    const work: Work = {
      name: "lint",
      kind: "skill",
      path,
      description: undefined,
      home: undefined,
      row: undefined,
      base: undefined,
    };
    const published = {
      source: { adapter: { id: "local", capabilities: { fileSpec: true } } },
      latest: new Map([
        ["eng/skill/lint", { id: "lint", version: "1.2.0", digests: ["sha256:older"] }],
      ]),
      withheld: new Map(),
    } as unknown as Published;

    const planned = await plan(work, published, "eng", "minor", undefined, false);
    expect(planned.version).toBe("1.3.0");
    expect(planned.input.version).toBe("1.3.0");
    expect(planned.input.files.map((file) => file.path).sort()).toEqual(["SKILL.md", "model.bin"]);
    expect(offerFrom).toHaveBeenCalledTimes(1);
  });
});

describe("plan's changes", () => {
  test("compares the files and edges it sends with the latest version's", async () => {
    const path = join(root, "lint");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), "---\nname: lint\ndescription: Lints code.\n---\n");
    await writeFile(join(path, "rules.md"), "Rules.\n");
    const work: Work = {
      name: "lint",
      kind: "skill",
      path,
      description: undefined,
      home: undefined,
      row: undefined,
      base: undefined,
    };
    const { files } = await offerFrom(path, { name: "lint", kind: "skill", version: "1.0.0" });
    const skill = files.find((file) => file.path === "SKILL.md");
    const holding = (current: Record<string, unknown> | undefined, withheld = false) =>
      ({
        alias: "acme",
        source: { adapter: { id: "probe", capabilities: { relationships: true } } },
        latest: new Map(current === undefined || withheld ? [] : [["eng/skill/lint", current]]),
        withheld: new Map(withheld ? [["eng/skill/lint", current]] : []),
      }) as unknown as Published;
    const edge = { rel_type: "depends_on", to: "eng/skill/style@1.3.0" };
    const latest = {
      id: "lint",
      version: "1.0.0",
      digests: ["sha256:old", skill?.digest],
      files: [skill, { path: "old.md", digest: "sha256:old" }],
      relationships: [{ ...edge, to: "eng/skill/style@1.2.0" }],
    };

    const update = await plan(work, holding(latest), "eng", "patch", undefined, false, [edge]);
    expect(update.changes).toEqual({
      files: { added: ["rules.md"], changed: [], removed: ["old.md"] },
      dependsOn: { added: ["eng/skill/style@1.3.0"], removed: ["eng/skill/style@1.2.0"] },
    });
    const add = await plan(work, holding(undefined), "eng", "patch", undefined, false, [edge]);
    expect(add.changes).toEqual({
      files: { added: ["SKILL.md", "rules.md"], changed: [], removed: [] },
      dependsOn: { added: ["eng/skill/style@1.3.0"], removed: [] },
    });

    const blocked = { id: undefined, version: "1.0.0", digests: [], withheld: {} };
    expect(
      (await plan(work, holding(blocked, true), "eng", "patch", undefined, false)).changes,
    ).toBeUndefined();

    const yanked = {
      ...holding(undefined),
      newest: [{ name: "lint", group: "eng", kind: "skill", version: "1.0.0" }],
    } as Published;
    const past = await plan(work, yanked, "eng", "patch", undefined, false);
    expect(past).toMatchObject({ from: "1.0.0", version: "1.0.1" });
    expect(past.changes).toBeUndefined();
    const same = { ...latest, digests: files.map((file) => file.digest).sort(), files };
    const unchanged = await plan(work, holding(same), "eng", "patch", undefined, false);
    expect(unchanged).toMatchObject({ same: true });
    expect(unchanged.changes).toBeUndefined();
  });
});

describe("plan for a folder agent", () => {
  test("refuses one with files beyond AGENT.md to a registry that keeps only AGENT.md", async () => {
    const path = join(root, "helper");
    await mkdir(join(path, "workspace"), { recursive: true });
    await writeFile(join(path, "AGENT.md"), "---\nname: helper\ndescription: Helps.\n---\n");
    await writeFile(join(path, "workspace", "AGENTS.md"), "How.\n");
    const work: Work = {
      name: "helper",
      kind: "agent",
      path,
      description: undefined,
      home: undefined,
      row: undefined,
      base: undefined,
    };
    const at = (capabilities: Record<string, boolean>) =>
      ({
        alias: "acme",
        source: { adapter: { id: "probe", capabilities } },
        latest: new Map(),
        withheld: new Map(),
      }) as unknown as Published;
    await expect(plan(work, at({}), "eng", "patch", undefined, false)).rejects.toMatchObject({
      message: "helper has files beyond its AGENT.md, but acme keeps only an agent's AGENT.md.",
      code: "usage",
    });
    const planned = await plan(work, at({ agentFolders: true }), "eng", "patch", undefined, false);
    expect(planned.input.files.map((file) => file.path)).toEqual([
      "AGENT.md",
      "workspace/AGENTS.md",
    ]);
    expect(planned.input.spec).toMatchObject({ name: "helper", description: "Helps." });
  });
});

describe("plan with relationships", () => {
  const edge = { rel_type: "depends_on", to: "eng/skill/style@1.2.0" };

  async function lint(): Promise<{ work: Work; digests: string[] }> {
    const path = join(root, "lint");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), "---\nname: lint\ndescription: Lints code.\n---\n");
    const work: Work = {
      name: "lint",
      kind: "skill",
      path,
      description: undefined,
      home: undefined,
      row: undefined,
      base: undefined,
    };
    const { digests } = await offerFrom(path, { name: "lint", kind: "skill", version: "1.0.0" });
    vi.mocked(offerFrom).mockClear();
    return { work, digests };
  }

  const publishedAt = (
    capabilities: Record<string, boolean>,
    current?: { digests: string[]; relationships?: unknown[] },
  ) =>
    ({
      alias: "acme",
      source: { adapter: { id: "probe", capabilities } },
      latest: new Map(
        current === undefined
          ? []
          : [["eng/skill/lint", { id: "lint", version: "1.0.0", ...current }]],
      ),
      withheld: new Map(),
    }) as unknown as Published;

  test("refuses an adapter that does not store them, before reading the files", async () => {
    const { work } = await lint();
    const refused = plan(work, publishedAt({ fileSpec: true }), "eng", "patch", undefined, false, [
      edge,
    ]);
    await expect(refused).rejects.toMatchObject({
      message: "lint has dependencies, but acme does not store them with a published version.",
      code: "usage",
    });
    expect(offerFrom).not.toHaveBeenCalled();
    // Without any, the same adapter still takes the work.
    await expect(
      plan(work, publishedAt({ fileSpec: true }), "eng", "patch", undefined, false, []),
    ).resolves.toMatchObject({ version: "0.1.0" });
  });

  test("sends them, and publishes again when only an edge moved", async () => {
    const { work, digests } = await lint();
    const stored = publishedAt({ relationships: true }, { digests, relationships: [edge] });

    const same = await plan(work, stored, "eng", "patch", undefined, false, [edge]);
    expect(same.same).toBe(true);

    const moved = { ...edge, to: "eng/skill/style@1.3.0" };
    const next = await plan(work, stored, "eng", "patch", undefined, false, [moved]);
    expect(next).toMatchObject({ same: false, version: "1.0.1" });
    expect(next.input.relationships).toEqual([moved]);

    const dropped = await plan(work, stored, "eng", "patch", undefined, false, []);
    expect(dropped.same).toBe(false);
    expect(dropped.input).not.toHaveProperty("relationships");
  });

  test("leaves sameness to the files when the publish names no relationships", async () => {
    const { work, digests } = await lint();
    const stored = publishedAt({ relationships: true }, { digests, relationships: [edge] });
    expect((await plan(work, stored, "eng", "patch", undefined, false)).same).toBe(true);
  });
});

describe("plan with an export's version", () => {
  async function exported(version: string): Promise<{ work: Work; digests: string[] }> {
    const path = join(root, "lint");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), "---\nname: lint\ndescription: Lints code.\n---\n");
    const work: Work = {
      name: "lint",
      kind: "skill",
      path,
      description: undefined,
      home: undefined,
      row: undefined,
      base: undefined,
      exported: { path: "lint", version, dependsOn: [], publish: undefined },
    };
    const { digests } = await offerFrom(path, { name: "lint", kind: "skill", version });
    return { work, digests };
  }

  const holding = (latest: string[], older: string[] = ["sha256:other"]) =>
    ({
      alias: "acme",
      source: {
        adapter: { id: "probe", capabilities: {} },
        handle: {
          resolve: async (wants: { version?: string }[]) => ({
            artifacts: wants.some((want) => want.version === "0.9.0")
              ? [
                  {
                    id: "lint",
                    kind: "skill",
                    envelope: {
                      metadata: { version: "0.9.0" },
                      files: older.map((digest) => ({ path: "SKILL.md", digest })),
                    },
                  },
                ]
              : [],
            withheld: wants.some((want) => want.version === "0.8.0")
              ? [
                  {
                    name: "lint",
                    namespace: "eng",
                    kind: "skill",
                    version: "0.8.0",
                    status: "blocked",
                    reason: "leaks tokens",
                  },
                ]
              : [],
          }),
        },
      },
      latest: new Map([["eng/skill/lint", { id: "lint", version: "1.0.0", digests: latest }]]),
      withheld: new Map(),
    }) as unknown as Published;

  test("publishes that version, past the newest, rather than the next patch", async () => {
    const { work } = await exported("2.0.0");
    const planned = await plan(work, holding(["sha256:older"]), "eng", "patch", undefined, false);
    expect(planned).toMatchObject({ same: false, from: "1.0.0", version: "2.0.0" });
  });

  test("is the same when the registry holds that version with these files", async () => {
    const newest = await exported("1.0.0");
    const same = await plan(newest.work, holding(newest.digests), "eng", "patch", undefined, false);
    expect(same).toMatchObject({ same: true, version: "1.0.0" });

    const older = await exported("0.9.0");
    const held = holding(["sha256:newer"], older.digests);
    expect(await plan(older.work, held, "eng", "patch", undefined, false)).toMatchObject({
      same: true,
      version: "0.9.0",
    });
  });

  test("refuses that version when the registry holds it with other files", async () => {
    const { work } = await exported("0.9.0");
    await expect(
      plan(work, holding(["sha256:newer"]), "eng", "patch", undefined, false),
    ).rejects.toMatchObject({ message: "eng/lint@0.9.0 is already published.", code: "conflict" });
  });

  test("refuses that version when the registry holds it back, though a resolve does not return it", async () => {
    const { work } = await exported("0.8.0");
    await expect(
      plan(work, holding(["sha256:newer"]), "eng", "patch", undefined, false),
    ).rejects.toMatchObject({
      message: "eng/lint@0.8.0 is already published, and is blocked (leaks tokens).",
      code: "conflict",
    });

    const named = { ...work, exported: undefined };
    await expect(
      plan(named, holding(["sha256:newer"]), "eng", "patch", "0.8.0", false),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("refuses a fixed version when its exact dependency changes", async () => {
    const { work, digests } = await exported("1.0.0");
    const edge = { rel_type: "depends_on", to: "eng/skill/style@1.2.0" };
    const stored = {
      alias: "acme",
      source: { adapter: { id: "probe", capabilities: { relationships: true } } },
      latest: new Map([
        ["eng/skill/lint", { id: "lint", version: "1.0.0", digests, relationships: [edge] }],
      ]),
      withheld: new Map(),
    } as unknown as Published;
    const at = (relationships: { rel_type: string; to: string }[]) =>
      plan(work, stored, "eng", "patch", undefined, false, relationships);

    expect(await at([edge])).toMatchObject({ same: true, version: "1.0.0" });

    for (const moved of [
      [{ ...edge, to: "eng/skill/style@2.0.0" }],
      [{ ...edge, to: "eng/skill/other@1.2.0" }],
      [edge, { rel_type: "depends_on", to: "eng/skill/format@1.0.0" }],
      [],
    ]) {
      await expect(at(moved)).rejects.toMatchObject({ code: "conflict" });
    }
  });

  test("says when that version is below the newest", async () => {
    const { work } = await exported("0.9.5");
    const planned = await plan(work, holding(["sha256:newer"]), "eng", "patch", undefined, false);
    expect(planned).toMatchObject({ from: "1.0.0", version: "0.9.5", belowLatest: true });
    const past = await exported("2.0.0");
    expect(
      (await plan(past.work, holding(["sha256:newer"]), "eng", "patch", undefined, false))
        .belowLatest,
    ).toBe(false);
  });

  test("takes the next version past a newest one the registry holds back", async () => {
    const path = join(root, "lint");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), "---\nname: lint\ndescription: Lints code.\n---\n");
    const work: Work = {
      name: "lint",
      kind: "skill",
      path,
      description: undefined,
      home: undefined,
      row: undefined,
      base: undefined,
    };
    const published = {
      alias: "acme",
      source: { adapter: { id: "probe", capabilities: {} } },
      latest: new Map(),
      withheld: new Map([
        ["eng/skill/lint", { id: undefined, version: "1.4.0", digests: [], withheld: {} }],
      ]),
    } as unknown as Published;
    const planned = await plan(work, published, "eng", "patch", undefined, false);
    expect(planned).toMatchObject({ same: false, from: "1.4.0", version: "1.4.1" });
  });

  test("takes the next version past one the listing does not show, such as a yanked one", async () => {
    const path = join(root, "lint");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), "---\nname: lint\ndescription: Lints code.\n---\n");
    const work: Work = {
      name: "lint",
      kind: "skill",
      path,
      description: undefined,
      home: undefined,
      row: undefined,
      base: undefined,
    };
    const holding = (latest: [string, unknown][], newest: string) =>
      ({
        alias: "acme",
        source: { adapter: { id: "probe", capabilities: {} } },
        latest: new Map(latest),
        withheld: new Map(),
        newest: [
          { name: "lint", group: "eng", kind: "skill", version: newest },
          { name: "lint", group: "ops", kind: "skill", version: "9.0.0" },
        ],
      }) as unknown as Published;
    const latest: [string, unknown][] = [
      ["eng/skill/lint", { id: "lint", version: "0.1.0", digests: ["sha256:older"] }],
    ];

    const past = await plan(work, holding(latest, "0.1.1"), "eng", "patch", undefined, false);
    expect(past).toMatchObject({ same: false, from: "0.1.0", version: "0.1.2" });
    const minor = await plan(work, holding(latest, "0.3.0"), "eng", "minor", undefined, false);
    expect(minor.version).toBe("0.4.0");

    const none = await plan(work, holding([], "0.1.0"), "eng", "patch", undefined, false);
    expect(none).toMatchObject({ from: "0.1.0", version: "0.1.1" });
  });
});

describe("commitAndPush", () => {
  test("commits in the folder named, quoting what a shell would read differently", () => {
    expect(commitAndPush("add triage 0.1.0")).toBe(
      'git add . && git commit -m "add triage 0.1.0" && git push',
    );
    expect(commitAndPush("fix $HOME's `id`", "../my registry")).toBe(
      `cd "../my registry" && git add . && git commit -m 'fix $HOME'\\''s \`id\`' && git push`,
    );
  });
});

describe("--to", () => {
  test("takes an exact version and rejects range syntax", () => {
    expect(parseTo("acme/eng/skill/lint@1.2.0").version).toBe("1.2.0");
    expect(() => parseTo("acme/eng/skill/lint@^1.2")).toThrow();
  });
});
