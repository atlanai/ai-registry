import { describe, expect, it } from "vitest";
import { BUILTIN_HARNESSES } from "#harnesses/index.ts";
import { harnessProblems } from "./check.ts";
import type { HarnessDefinition, KindMapping } from "./contract.ts";

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
      "a codec on a folder with no entry file",
      [plugin({ codec: { id: "frontmatter-strict", keep: ["name"] } })],
      /needs an entry file/,
    ],
    [
      "profiles named outside the last segment",
      [harness({ instances: { root: "~/.tool/{profile}/home" } })],
      /only in its last segment/,
    ],
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
