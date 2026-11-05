import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { declareKinds, kindPlural, kindSpec, knownKinds, scannedKinds } from "#core/kinds.ts";
import { parseRef } from "#core/ref.ts";
import { loadTargetFiles } from "#core/target/load.ts";
import { publishOnly } from "#core/target/placement.ts";
import { resolveTargets } from "#core/target/table.ts";
import { test } from "#test/kit/fixtures.ts";
import type { KindContribution } from "./extend.ts";
import { acceptKinds, type Declaring } from "./kinds.ts";

const KNOWLEDGE = {
  name: "knowledge",
  dir: "knowledge",
  shape: "directory",
} satisfies KindContribution;
const PROMPT = {
  name: "prompt",
  dir: "prompt_files",
  shape: "file",
  extensions: [".md"],
  targets: { universal: { shape: "file", subdir: "prompts", extension: ".md" } },
} satisfies KindContribution;

const env = { HOME: "/nowhere", AIREG_HOME: "/nowhere/.aireg" };
const accept = (...declaring: Declaring[]) => acceptKinds(declaring, resolveTargets(env));
const names = (...declaring: Declaring[]) => accept(...declaring).kinds.map((kind) => kind.name);
const warned = (kinds: unknown) => accept({ adapter: "acme", kinds }).warnings;

afterEach(() => declareKinds([]));

describe("acceptKinds", () => {
  test("takes a directory kind and a file kind as data, with their target mappings", () => {
    const { kinds, warnings } = accept({ adapter: "acme", kinds: [KNOWLEDGE, PROMPT] });
    expect(warnings).toEqual([]);
    expect(kinds).toEqual([
      {
        name: "knowledge",
        spec: { dir: "knowledge", shape: "directory", extensions: [] },
        description: undefined,
        targets: {},
      },
      {
        name: "prompt",
        spec: { dir: "prompt_files", shape: "file", extensions: [".md"] },
        description: undefined,
        targets: { universal: PROMPT.targets.universal },
      },
    ]);
  });

  test("refuses a built-in's name or folder, costing that adapter every kind it declares", () => {
    const { kinds, warnings } = accept(
      { adapter: "shadow", kinds: [KNOWLEDGE, { ...KNOWLEDGE, name: "skill", dir: "shadows" }] },
      { adapter: "acme", kinds: [PROMPT] },
    );
    expect(kinds.map((kind) => kind.name)).toEqual(["prompt"]);
    expect(warnings).toEqual([
      'The adapter "shadow" declares kinds aireg cannot use, so it adds none: "skill" is a built-in kind.',
    ]);
    expect(warned([{ ...KNOWLEDGE, dir: "skills" }])).toEqual([
      'The adapter "acme" declares kinds aireg cannot use, so it adds none: "knowledge" keeps its artifacts in "skills", the built-in skills\' folder.',
    ]);
  });

  test.each([
    ["a name outside the grammar", { ...KNOWLEDGE, name: "Knowledge" }, "is not a kind name"],
    ["a folder that is a path", { ...KNOWLEDGE, dir: "../up" }, "has a `dir` that is not one"],
    ["a folder Windows opens as a device", { ...KNOWLEDGE, dir: "con" }, "has a `dir`"],
    ["a file kind with no extension", { ...PROMPT, extensions: [] }, "needs `extensions`"],
    ["an entry on a file kind", { ...PROMPT, entry: "x.md" }, "only a directory kind has"],
    ["an entry that is a path", { ...KNOWLEDGE, entry: "a/b.md" }, "is not a file name"],
    [
      "a target that does not exist",
      { ...KNOWLEDGE, targets: { nope: {} } },
      '"nope", which is not a target',
    ],
    [
      "a plugin's contents shape",
      { ...KNOWLEDGE, targets: { "claude-code": { shape: "contents" } } },
      "placed as a directory or a file",
    ],
    [
      "a register file outside the target's folder, such as the project's .mcp.json",
      {
        ...KNOWLEDGE,
        targets: {
          "claude-code": {
            shape: "directory",
            subdir: "mcp",
            register: [
              { file: "../.mcp.json", format: "json", at: ["mcpServers", "{name}"], value: {} },
            ],
          },
        },
      },
      "is not a path inside its root",
    ],
    [
      "a subdir that is the target's own folder",
      { ...KNOWLEDGE, targets: { "claude-code": { shape: "directory", subdir: "./" } } },
      "is not a folder of its own",
    ],
    [
      "a subdir inside a folder a built-in kind uses",
      { ...KNOWLEDGE, targets: { "claude-code": { shape: "directory", subdir: "skills/k" } } },
      "is where the target keeps plugins",
    ],
    [
      "a subdir holding a folder a built-in kind uses",
      { ...KNOWLEDGE, targets: { codex: { shape: "directory", subdir: "plugins" } } },
      "is where the target keeps plugins",
    ],
    [
      "a register entry in the target's own settings",
      {
        ...KNOWLEDGE,
        targets: {
          "claude-code": {
            shape: "directory",
            subdir: "knowledge",
            register: [{ file: "settings.json", format: "json", at: ["k", "{name}"], value: {} }],
          },
        },
      },
      "the target's own settings",
    ],
    [
      "a register entry in a shared file outside a table named for each artifact",
      {
        ...KNOWLEDGE,
        targets: {
          codex: {
            shape: "directory",
            subdir: "knowledge",
            register: [
              { file: "config.toml", format: "toml", at: ["features"], value: { k: true } },
            ],
          },
        },
      },
      "outside a table named for each artifact",
    ],
    [
      "a mapping a target file could not hold",
      { ...PROMPT, targets: { codex: { shape: "file", subdir: "prompts" } } },
      "maps codex wrongly",
    ],
  ])("refuses %s", (_, kind, problem) => {
    const [warning] = warned([kind]);
    expect(warning).toContain("declares kinds aireg cannot use, so it adds none:");
    expect(warning).toContain(problem);
  });

  test.each([
    "commands",
    "prompts",
    "hooks",
    "bin",
    "rules",
    "output-styles",
    "themes",
    "monitors",
    "mcp",
    "lsp",
    "local",
  ])("refuses the folder %s, which a plugin's loader reads", (dir) => {
    expect(warned([{ ...PROMPT, dir }])).toEqual([
      `The adapter "acme" declares kinds aireg cannot use, so it adds none: "prompt" keeps its artifacts in "${dir}", a folder plugins load.`,
    ]);
  });

  test("reads a target alias as the target it names", () => {
    const [kind] = accept({
      adapter: "acme",
      kinds: [{ ...KNOWLEDGE, targets: { claude: { shape: "directory", subdir: "knowledge" } } }],
    }).kinds;
    expect(Object.keys(kind?.targets ?? {})).toEqual(["claude-code"]);
  });

  test("takes one kind two adapters define alike, and refuses one they define differently", () => {
    expect(names({ adapter: "a", kinds: [PROMPT] }, { adapter: "b", kinds: [PROMPT] })).toEqual([
      "prompt",
    ]);
    const differ = accept(
      { adapter: "a", kinds: [PROMPT, KNOWLEDGE] },
      { adapter: "b", kinds: [{ ...PROMPT, extensions: [".txt"] }] },
    );
    expect(differ.kinds.map((kind) => kind.name)).toEqual(["knowledge"]);
    expect(differ.warnings).toEqual([
      'The adapters "a" and "b" define the kind "prompt" differently, so neither is loaded.',
    ]);
  });

  test("refuses two kinds that would share one folder", () => {
    const shared = accept(
      { adapter: "a", kinds: [KNOWLEDGE] },
      { adapter: "b", kinds: [{ ...KNOWLEDGE, name: "docs" }] },
    );
    expect(shared.kinds).toEqual([]);
    expect(shared.warnings[0]).toContain('in the folder "knowledge", so neither is loaded.');
  });
});

describe("declared kinds", () => {
  test("are known by their spec and scanned, but never read as kinds in a short address", () => {
    const short = { registry: "hosted", namespace: "knowledge", name: "accounts" };
    expect(parseRef("hosted/knowledge/accounts")).toEqual(short);
    declareKinds(accept({ adapter: "acme", kinds: [KNOWLEDGE, PROMPT] }).kinds);
    expect(kindSpec("prompt")).toEqual({ dir: "prompt_files", shape: "file", extensions: [".md"] });
    expect(kindPlural("prompt")).toBe("prompt artifacts");
    expect(knownKinds()).toEqual(["plugin", "skill", "agent", "knowledge", "prompt"]);
    // A folder kind with no entry file would take any folder, so it is never scanned.
    expect(scannedKinds().map(([kind]) => kind)).toEqual(["skill", "agent", "prompt"]);
    expect(parseRef("hosted/knowledge/accounts")).toEqual(short);
    expect(parseRef("hosted/eng/knowledge/accounts")).toMatchObject({ kind: "knowledge" });
  });

  test("are placed only where a mapping says, and publish-only with none", () => {
    declareKinds(accept({ adapter: "acme", kinds: [KNOWLEDGE, PROMPT] }).kinds);
    const table = resolveTargets(env);
    expect(table.universal?.kinds.prompt).toEqual(PROMPT.targets.universal);
    expect(table["claude-code"]?.kinds.prompt).toBeUndefined();
    expect(publishOnly("knowledge", table)).toBe(true);
    expect(publishOnly("prompt", table)).toBe(false);
    expect(publishOnly("skill", table)).toBe(false);
    expect(publishOnly("widget", table)).toBe(false);
  });

  test("register only beside what someone else wrote, and never delete a file on removal", () => {
    const register = { file: "config.toml", format: "toml", at: ["mcp_servers", "{name}"] };
    const [kind] = accept({
      adapter: "acme",
      kinds: [
        {
          ...KNOWLEDGE,
          targets: {
            codex: {
              shape: "directory",
              subdir: "knowledge",
              register: [
                {
                  ...register,
                  value: { command: "x" },
                  init: {},
                  remove: "entry",
                  conflict: "overwrite",
                },
              ],
            },
          },
        },
      ],
    }).kinds;
    expect(kind?.targets.codex?.register).toEqual([
      { ...register, value: { command: "x" }, conflict: "keep" },
    ]);
  });

  test("are checked again in target files once declared, which never place them as contents", async ({
    tmp,
  }) => {
    const home = { HOME: tmp, AIREG_HOME: join(tmp, ".aireg") };
    await mkdir(join(tmp, ".aireg", "targets"), { recursive: true });
    const tool = (kinds: Record<string, unknown>) =>
      JSON.stringify({
        id: "tool",
        displayName: "Tool",
        roots: { project: ".tool", user: { default: "~/.tool" } },
        kinds: { skill: { shape: "directory", subdir: "skills" }, ...kinds },
      });
    const file = join(tmp, ".aireg", "targets", "tool.json");
    await writeFile(file, tool({ knowledge: { shape: "contents" } }));
    expect(loadTargetFiles(home).skipped.flatMap((each) => each.problems)).toEqual([
      "kinds.knowledge: only a plugin is placed as its contents.",
    ]);
    const entry = { knowledge: { shape: "directory", subdir: "k", entry: "K.md" } };
    await writeFile(file, tool(entry));
    expect(loadTargetFiles(home).skipped).toEqual([]);
    declareKinds(accept({ adapter: "acme", kinds: [KNOWLEDGE] }).kinds);
    expect(loadTargetFiles(home).skipped.flatMap((each) => each.problems)).toEqual([
      "kinds.knowledge: entry is for a kind that is one file.",
    ]);
  });

  test("never replace a mapping a target file already gives the kind", async ({ tmp }) => {
    const home = { HOME: tmp, AIREG_HOME: join(tmp, ".aireg") };
    await mkdir(join(tmp, ".aireg", "targets"), { recursive: true });
    const own = { shape: "file", subdir: "my-prompts", extension: ".md" };
    await writeFile(
      join(tmp, ".aireg", "targets", "tool.json"),
      JSON.stringify({
        id: "tool",
        displayName: "Tool",
        roots: { project: ".tool", user: { default: "~/.tool" } },
        kinds: { skill: { shape: "directory", subdir: "skills" }, prompt: own },
      }),
    );
    const mapped = {
      ...PROMPT,
      targets: { ...PROMPT.targets, tool: { ...own, subdir: "theirs" } },
    };
    declareKinds(acceptKinds([{ adapter: "acme", kinds: [mapped] }], resolveTargets(home)).kinds);
    expect(resolveTargets(home).tool?.kinds.prompt).toEqual(own);
  });
});
