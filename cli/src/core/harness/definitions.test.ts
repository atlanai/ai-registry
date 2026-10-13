import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { type ArtifactKind, KINDS } from "#core/kinds.ts";
import { BUILTIN_HARNESSES } from "#harnesses/index.ts";
import type { ConfigValue, HarnessDefinition, KindMapping, RegisterEntry } from "./contract.ts";
import { templateVars } from "./template.ts";

/** Every `{var}` a definition may use, by where it is used. */
const TEMPLATE_VARS = {
  /** A kind's `subdir`. */
  placement: ["name", "source"],
  /** A plugin manifest's body. */
  manifest: ["name", "description"],
  /** A register entry: what its placement's path carries, and the harness root. */
  register: ["name", "source", "root"],
} as const;

/**
 * What types cannot say: ids that resolve, templates that use only the
 * variables their place fills, and paths that stay inside their root.
 */
function harnessProblems(definitions: readonly HarnessDefinition[]): string[] {
  const problems: string[] = [];
  const byId = new Map<string, HarnessDefinition>();
  for (const definition of definitions) {
    if (byId.has(definition.id)) problems.push(`${definition.id} is defined twice.`);
    byId.set(definition.id, definition);
  }
  for (const definition of definitions) {
    const report = (problem: string) => problems.push(`${definition.id}: ${problem}`);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(definition.id)) report("the id is not a lowercase name.");
    if (!definition.roots.user.default.startsWith("~/")) report("the user root is not under ~/.");
    for (const path of [definition.roots.project, definition.roots.user.default.slice(2)]) {
      pathProblem(path, [], report);
    }
    for (const kind of KINDS) {
      const mapping = definition.kinds[kind];
      if (mapping !== undefined) mappingProblems(kind, mapping, report);
      for (const read of definition.reads?.[kind] ?? [])
        readProblem(kind, byId.get(read), read, report);
    }
  }
  return problems;
}

function readProblem(
  kind: ArtifactKind,
  found: HarnessDefinition | undefined,
  read: string,
  report: (problem: string) => void,
) {
  if (found === undefined) report(`reads.${kind} names ${read}, which is not a harness.`);
  else if (found.kinds[kind] === undefined) {
    report(`reads.${kind} names ${read}, which places no ${kind}.`);
  }
}

function mappingProblems(kind: string, mapping: KindMapping, report: (problem: string) => void) {
  if (mapping.shape === "contents") return;
  pathProblem(mapping.subdir, TEMPLATE_VARS.placement, report);
  for (const entry of mapping.manifest ?? []) {
    pathProblem(entry.path, [], report);
    valueProblems(entry.body ?? {}, TEMPLATE_VARS.manifest, report);
  }
  // A register entry can use only what its placement path carries, and the root.
  const carried = templateVars(mapping.subdir);
  if (!mapping.subdir.includes("{")) carried.push("name");
  const usable = TEMPLATE_VARS.register.filter((name) => name === "root" || carried.includes(name));
  for (const entry of mapping.register ?? []) {
    registerProblems(kind, entry, usable, report);
  }
  // Written unquoted, so each key must be a bare one.
  for (const key of [...(mapping.render?.fields ?? []), mapping.render?.body ?? "body"]) {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) report(`${kind} renders ${key}, which is not a bare key.`);
  }
}

function registerProblems(
  kind: string,
  entry: RegisterEntry,
  vars: readonly string[],
  report: (problem: string) => void,
) {
  pathProblem(
    entry.file,
    vars.filter((name) => name !== "root"),
    report,
  );
  if (entry.at.length === 0) report(`kinds.${kind}: a register entry names no table.`);
  for (const key of entry.at) templateProblems(key, vars, report);
  for (const value of [entry.value, entry.off, entry.init])
    valueProblems(value ?? {}, vars, report);
  if (entry.upsert !== undefined) {
    if (entry.format !== "json") report(`kinds.${kind}: upsert needs a JSON file.`);
    if (entry.upsert.item[entry.upsert.key] === undefined) {
      report(`kinds.${kind}: an upsert item must set ${entry.upsert.key}.`);
    }
    valueProblems(entry.upsert.item, vars, report);
  }
  if (entry.init !== undefined && entry.format !== "json") {
    report(`kinds.${kind}: init is for JSON files.`);
  }
}

function pathProblem(path: string, vars: readonly string[], report: (problem: string) => void) {
  if (path === "" || isAbsolute(path) || path.split("/").includes("..")) {
    report(`${path} is not a path inside its root.`);
  }
  templateProblems(path, vars, report);
}

function templateProblems(
  text: string,
  vars: readonly string[],
  report: (problem: string) => void,
) {
  for (const name of templateVars(text)) {
    if (!vars.includes(name)) report(`${text} uses {${name}}, which nothing fills there.`);
  }
}

function valueProblems(
  value: ConfigValue,
  vars: readonly string[],
  report: (problem: string) => void,
) {
  if (typeof value === "string") templateProblems(value, vars, report);
  else if (Array.isArray(value)) for (const item of value) valueProblems(item, vars, report);
  else if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      templateProblems(key, vars, report);
      valueProblems(item, vars, report);
    }
  }
}

describe("built-in harnesses", () => {
  it("resolve every id they name, fill every template, and stay in their roots", () => {
    expect(harnessProblems(BUILTIN_HARNESSES)).toEqual([]);
  });
});

function harness(overrides: Partial<HarnessDefinition> = {}): HarnessDefinition {
  return {
    id: "tool",
    displayName: "Tool",
    roots: { project: ".tool", user: { default: "~/.tool" } },
    kinds: { skill: { shape: "directory", subdir: "skills" } },
    ...overrides,
  };
}

const plugin = (mapping: Partial<Extract<KindMapping, { shape: "directory" }>>) =>
  harness({
    kinds: { plugin: { shape: "directory", subdir: "plugins/{source}/{name}", ...mapping } },
  });

describe("harnessProblems", () => {
  it("finds nothing wrong with a minimal definition", () => {
    expect(harnessProblems([harness()])).toEqual([]);
  });

  it.each([
    ["a duplicate id", [harness(), harness()], /defined twice/],
    ["a read of no harness", [harness({ reads: { skill: ["ghost"] } })], /not a harness/],
    [
      "a read of a kind it does not place",
      [harness({ reads: { agent: ["tool"] } })],
      /places no agent/,
    ],
    [
      "a user root outside home",
      [harness({ roots: { project: ".tool", user: { default: "/opt/tool" } } })],
      /not under ~/,
    ],
    [
      "a path that climbs out",
      [harness({ roots: { project: "../tool", user: { default: "~/.tool" } } })],
      /inside its root/,
    ],
    ["a variable a placement does not fill", [plugin({ subdir: "plugins/{owner}" })], /\{owner\}/],
    [
      "a register variable its placement does not carry",
      [
        plugin({
          subdir: "plugins/{name}",
          register: [
            { file: "c.toml", format: "toml", at: ["p", "{source}"], value: { on: true } },
          ],
        }),
      ],
      /\{source\}/,
    ],
    [
      "an upsert item without its key",
      [
        plugin({
          register: [
            {
              file: "m.json",
              format: "json",
              at: ["plugins"],
              upsert: { key: "name", item: { path: "x" } },
            },
          ],
        }),
      ],
      /must set name/,
    ],
    [
      "init on a TOML file",
      [
        plugin({
          register: [
            { file: "c.toml", format: "toml", at: ["p"], value: { on: true }, init: { a: 1 } },
          ],
        }),
      ],
      /init is for JSON/,
    ],
  ])("reports %s", (_, definitions, problem) => {
    expect(harnessProblems(definitions).join("\n")).toMatch(problem);
  });
});
