import { describe, expect, test } from "vitest";
import { GLOBAL_OPTIONS } from "#cli/options/flags.ts";
import { ErrorCode, ExitCode } from "#core/errors.ts";
import { Printer } from "#core/term/printer.ts";
import { homeTest } from "#test/kit/fixtures.ts";
import { buildMap, findMapFormat, type MapNode, runMap } from "./map.ts";

function capture(format: "text" | "json") {
  const out: string[] = [];
  const err: string[] = [];
  const printer = new Printer({
    format,
    out: { write: (chunk: string) => out.push(chunk), isTTY: false },
    err: { write: (chunk: string) => err.push(chunk), isTTY: false },
  });
  return { printer, out, err };
}

describe("findMapFormat", () => {
  test.each([
    [["--map"], "tree"],
    [["--map=json"], "json"],
    [["--map", "json"], "json"],
    // A following flag or a word that is not a format stays an argument.
    [["--map", "--json"], "tree"],
    [["--map", "add"], "tree"],
    [["add", "--map=compact", "kit"], "compact"],
    [["add", "kit"], undefined],
  ])("reads %j as %s", (argv, format) => {
    expect(findMapFormat(argv)).toBe(format);
  });
});

describe("buildMap", () => {
  homeTest("carries summary, group and aliases from the command spec", async () => {
    const root = await buildMap();
    const init = root.children?.find((c) => c.path === "aireg init");
    expect(init?.summary).toBe("Set up a project (creates .registry/manifest.yml)");
    expect(init?.group).toBe("Set up");
    const rm = root.children?.find((c) => c.path === "aireg remove");
    expect(rm?.aliases).toEqual(["rm"]);
  });

  homeTest("gives every list action the ls alias and every remove action rm", async () => {
    const walk = (node: MapNode): MapNode[] => [node, ...(node.children ?? []).flatMap(walk)];
    const nodes = walk(await buildMap());
    const lists = nodes.filter(({ path }) => path.endsWith(" list"));
    const removes = nodes.filter(({ path }) => path.endsWith(" remove"));
    expect(lists.length).toBeGreaterThan(1);
    expect(removes.length).toBeGreaterThan(1);
    for (const { path, aliases } of lists) expect(aliases, path).toContain("ls");
    for (const { path, aliases } of removes) expect(aliases, path).toContain("rm");
  });

  homeTest("carries only the global options at the root", async () => {
    const root = await buildMap();
    expect(root.options?.map((o) => o.flag)).toEqual(GLOBAL_OPTIONS.map((o) => o.flag));
    expect(root.options?.map((o) => o.flag)).not.toContain("--user");
  });

  homeTest(
    "carries each command's usage and options, and each action's, inheriting nothing",
    async () => {
      const root = await buildMap();
      const add = root.children?.find((c) => c.path === "aireg add");
      expect(add?.usage?.[0]).toMatch(/^aireg add /);
      expect(add?.options).toContainEqual(
        expect.objectContaining({ flag: "--select", short: "-s", value: "<name>", multiple: true }),
      );
      expect(add?.docs).toBe("https://atlanai.github.io/ai-registry/reference/add/");
      const registry = root.children?.find((c) => c.path === "aireg registry");
      const list = registry?.children?.find((c) => c.path === "aireg registry list");
      expect(list?.summary).toBe("List the registries you have declared");
      expect(list?.options?.map((o) => o.flag)).toEqual(["--user"]);
      const doctor = root.children?.find((c) => c.path === "aireg doctor");
      expect(doctor?.options).toBeUndefined();
    },
  );

  homeTest("never lists a hidden option", async () => {
    const root = await buildMap();
    const update = root.children?.find((c) => c.path === "aireg update");
    expect(update?.options?.map((o) => o.flag)).not.toContain("--force");
    expect(JSON.stringify(root)).not.toContain('"hidden"');
  });
});

describe("runMap", () => {
  homeTest("prints an indented tree by default, root before children before actions", async () => {
    const { printer, out } = capture("text");
    const code = await runMap(printer, "tree");
    expect(code).toBe(ExitCode.Ok);
    const text = out.join("");
    expect(text).toContain(
      "aireg\tInstall agent artifacts from any registry into any coding agent.",
    );
    expect(text).toContain("  aireg add\tInstall artifacts from a registry");
    expect(text).toContain("    aireg registry add");
  });

  homeTest("prints one path per line, parents before children, in compact format", async () => {
    const { printer, out } = capture("text");
    await runMap(printer, "compact");
    const lines = out.join("").trimEnd().split("\n");
    expect(lines[0]).toBe("aireg");
    expect(lines.indexOf("aireg registry")).toBeLessThan(lines.indexOf("aireg registry add"));
    expect(lines.some((line) => line.includes("\t"))).toBe(false);
  });

  homeTest("prints the indented JSON tree directly when --json was not given", async () => {
    const { printer, out } = capture("text");
    await runMap(printer, "json");
    const tree = JSON.parse(out.join(""));
    expect(tree.path).toBe("aireg");
    expect(tree.options).toHaveLength(GLOBAL_OPTIONS.length);
  });

  homeTest("wraps the tree in the ok envelope when the global --json flag is given", async () => {
    const { printer, out } = capture("json");
    await runMap(printer, "tree");
    const payload = JSON.parse(out.join(""));
    expect(payload).toMatchObject({ ok: true });
    expect(payload.data.path).toBe("aireg");
  });

  homeTest("rejects an unknown format as a usage error naming the valid ones", async () => {
    const { printer } = capture("text");
    await expect(runMap(printer, "yaml")).rejects.toMatchObject({
      name: "AiregError",
      code: ErrorCode.Usage,
      hint: "Use tree, compact or json.",
    });
  });
});
