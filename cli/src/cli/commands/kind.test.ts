import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { ErrorCode } from "#core/errors.ts";
import { indexRoot } from "#core/filespec/indexer.ts";
import { writeRoot } from "#core/filespec/init.ts";
import { validateRoot } from "#core/filespec/validate/validate.ts";
import { Printer } from "#core/term/printer.ts";
import { test } from "#test/kit/fixtures.ts";
import type { CommandContext } from "./command.ts";
import { lookup } from "./index.ts";

function context(cwd: string, argv: string[]): CommandContext {
  return {
    argv,
    cwd,
    printer: new Printer({ format: "json", out: { write: () => undefined, isTTY: false } }),
    host: {
      version: "test",
      connectAccount: async () => {
        throw new Error("no host");
      },
      openRunStore: async () => {
        throw new Error("no host");
      },
    },
  };
}

describe("skill new --set", () => {
  test.for(["__proto__.polluted=1", "constructor.prototype.polluted=1"])(
    "refuses %s and leaves every object alone",
    async (pair, { tmp }) => {
      const { run } = await ((await lookup("skill", tmp))?.load() ?? Promise.reject());
      await expect(run(context(tmp, ["new", "probe", "--set", pair]))).rejects.toMatchObject({
        code: ErrorCode.Usage,
      });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );
});

describe("skill new without a name", () => {
  test("refuses in a registry when it can't ask, instead of naming it after the folder", async ({
    tmp,
  }) => {
    await writeFile(join(tmp, "registry.json"), "{}\n");
    const namespace = join(tmp, "artifacts", "engineering");
    await mkdir(namespace, { recursive: true });
    const { run } = await ((await lookup("skill", tmp))?.load() ?? Promise.reject());
    await expect(run(context(namespace, ["new"]))).rejects.toMatchObject({
      code: ErrorCode.Usage,
    });
    expect(await readdir(namespace)).toEqual([]);
  });
});

describe("native agent import and indexing", () => {
  test.for([undefined, "recipe-helper"])(
    "preserves a card with a human-readable name (%s)",
    async (override, { tmp }) => {
      const root = join(tmp, "registry");
      const source = join(tmp, "source");
      await mkdir(source);
      await writeRoot(root, { name: "team" }, "2026-10-14T00:00:00Z");
      const card = JSON.stringify(
        { name: "Recipe Agent", description: "Recipes.", skills: [], custom: { keep: true } },
        null,
        2,
      );
      await writeFile(join(source, "agent-card.json"), card);
      await writeFile(join(source, "README.md"), "Supporting documentation.");
      await writeFile(join(source, "a.json"), '{"name":"wrong"}');
      const { run } = await ((await lookup("agent", root))?.load() ?? Promise.reject());
      await run(
        context(root, [
          "new",
          "--from",
          source,
          "--namespace",
          "engineering",
          ...(override === undefined ? [] : ["--name", override]),
        ]),
      );
      const version = join(
        root,
        "artifacts/engineering/agent",
        override ?? "recipe-agent",
        "0.1.0",
      );
      expect(await readFile(join(version, "agent-card.json"), "utf8")).toBe(card);
      await indexRoot(root, "2026-10-14T00:00:00Z");
      const envelope = JSON.parse(await readFile(join(version, "artifact.json"), "utf8"));
      expect(envelope.spec).toEqual({
        name: override ?? "recipe-agent",
        description: "Recipes.",
        card: JSON.parse(card),
      });
      expect((await validateRoot(root)).problems).toEqual([]);
      const before = await readFile(join(version, "artifact.json"), "utf8");
      await indexRoot(root, "2026-10-15T00:00:00Z");
      expect(await readFile(join(version, "artifact.json"), "utf8")).toBe(before);
    },
  );

  test("preserves native agent configuration through import and indexing", async ({ tmp }) => {
    const root = join(tmp, "registry");
    const source = join(tmp, "source");
    await mkdir(source);
    await writeRoot(root, { name: "team" }, "2026-10-14T00:00:00Z");
    const body =
      "---\nname: reviewer\ndescription: Reviews code.\ntools: Read, Grep\nmodel: sonnet\ncustom:\n  enabled: true\n---\nReview.\n";
    await writeFile(join(source, "AGENT.md"), body);
    const { run } = await ((await lookup("agent", root))?.load() ?? Promise.reject());
    await run(context(root, ["new", "--from", source, "--namespace", "engineering"]));
    await indexRoot(root, "2026-10-14T00:00:00Z");
    const version = join(root, "artifacts/engineering/agent/reviewer/0.1.0");
    expect(await readFile(join(version, "AGENT.md"), "utf8")).toBe(body);
    const envelope = JSON.parse(await readFile(join(version, "artifact.json"), "utf8"));
    expect(envelope.spec).toEqual({
      name: "reviewer",
      description: "Reviews code.",
      tools: "Read, Grep",
      model: "sonnet",
      custom: { enabled: true },
    });
    expect((await validateRoot(root)).problems).toEqual([]);
  });
});

describe("writes stay inside the registry", () => {
  /** A registry with `eng/skill/lint` at 0.1.0, and an empty folder outside it. */
  async function registry(tmp: string): Promise<{ root: string; outside: string; lint: string }> {
    const root = join(tmp, "registry");
    const outside = join(tmp, "outside");
    await writeRoot(root, { name: "team" }, "2026-10-14T00:00:00Z");
    await mkdir(outside);
    const lint = join(root, "artifacts", "eng", "skill", "lint");
    await mkdir(join(lint, "0.1.0"), { recursive: true });
    await writeFile(join(lint, "0.1.0", "SKILL.md"), "---\nname: lint\ndescription: L.\n---\n");
    return { root, outside, lint };
  }

  async function skill(root: string, argv: string[]): Promise<void> {
    const { run } = await ((await lookup("skill", root))?.load() ?? Promise.reject());
    await run(context(root, argv));
  }

  test.for([
    ["new", ["new", "demo", "--namespace", "ops", "--yes"]],
    ["new --from", ["new", "--from", "SOURCE", "--namespace", "ops", "--yes"]],
  ] as const)("refuses %s through a linked namespace folder", async ([, argv], { tmp }) => {
    const { root, outside } = await registry(tmp);
    const source = join(tmp, "demo");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "---\nname: demo\ndescription: D.\n---\n");
    await symlink(outside, join(root, "artifacts", "ops"));

    const args = argv.map((arg) => (arg === "SOURCE" ? source : arg));
    await expect(skill(root, args)).rejects.toMatchObject({ code: ErrorCode.Invalid });
    expect(await readdir(outside)).toEqual([]);
  });

  test("refuses new --from a file that is a symlink, and leaves its target", async ({ tmp }) => {
    const { root, outside } = await registry(tmp);
    const original = "---\nname: demo\ndescription: D.\n---\n";
    await writeFile(join(outside, "SKILL.md"), original);
    const source = join(tmp, "SKILL.md");
    await symlink(join(outside, "SKILL.md"), source);

    const argv = ["new", "--from", source, "--name", "renamed", "--namespace", "ops", "--yes"];
    await expect(skill(root, argv)).rejects.toMatchObject({ code: ErrorCode.Invalid });
    expect(await readFile(join(outside, "SKILL.md"), "utf8")).toBe(original);
  });

  test("refuses bump through a linked artifact folder", async ({ tmp }) => {
    const { root, outside, lint } = await registry(tmp);
    await mkdir(join(outside, "0.1.0"));
    await writeFile(join(outside, "0.1.0", "SKILL.md"), "---\nname: lint\ndescription: L.\n---\n");
    const linked = join(root, "artifacts", "eng", "skill", "probe");
    await symlink(outside, linked);

    await expect(skill(root, ["bump", "probe", "--namespace", "eng"])).rejects.toMatchObject({
      code: ErrorCode.Invalid,
    });
    expect(await readdir(outside)).toEqual(["0.1.0"]);
    expect(await readdir(lint)).toEqual(["0.1.0"]);
  });

  test("refuses bump onto a file already where the version goes", async ({ tmp }) => {
    const { root, lint } = await registry(tmp);
    await writeFile(join(lint, "0.1.1"), "keep");

    await expect(skill(root, ["bump", "lint", "--namespace", "eng"])).rejects.toMatchObject({
      code: ErrorCode.Conflict,
    });
    expect(await readFile(join(lint, "0.1.1"), "utf8")).toBe("keep");
  });
});
