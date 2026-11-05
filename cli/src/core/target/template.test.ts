import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { ErrorCode } from "#core/errors.ts";
import { test } from "#test/kit/fixtures.ts";
import {
  expand,
  expandValue,
  fixedPrefix,
  placementPattern,
  placementTemplate,
  templateVars,
} from "./template.ts";

describe("expand", () => {
  test("fills every variable, and refuses one nothing fills", () => {
    expect(templateVars("plugins/{source}/{name}")).toEqual(["source", "name"]);
    expect(expand("{name}@{source}", { name: "lint", source: "kit" })).toBe("lint@kit");
    expect(() => expand("{name}/{nope}", { name: "lint" })).toThrow(
      expect.objectContaining({ code: ErrorCode.Invalid }),
    );
  });

  test("normalizes a value that starts at the root, and leaves others as written", () => {
    expect(expand("{root}/a/../b", { root: "/home" })).toBe(join("/home", "b"));
    expect(expand("a/../{name}", { name: "x" })).toBe("a/../x");
  });

  test("expands keys as well as values, all the way down", () => {
    expect(
      expandValue(
        { "{name}": { enabled: true, path: ["{root}/{name}"] } },
        {
          name: "lint",
          root: "/r",
        },
      ),
    ).toEqual({ lint: { enabled: true, path: [join("/r", "lint")] } });
  });
});

describe("placementTemplate and fixedPrefix", () => {
  test("place a file kind with its extension and a directory kind by name", () => {
    expect(placementTemplate({ subdir: "agents", shape: "file", extension: ".md" })).toBe(
      "agents/{name}.md",
    );
    expect(placementTemplate({ subdir: "skills", shape: "directory" })).toBe("skills/{name}");
    expect(placementTemplate({ subdir: "cache/{source}/{name}", shape: "directory" })).toBe(
      "cache/{source}/{name}",
    );
    expect(placementTemplate({ shape: "contents" })).toBeUndefined();
  });

  test("keep only the segments before the first variable", () => {
    expect(fixedPrefix("plugins/cache/{source}/{name}")).toEqual(["plugins", "cache"]);
    expect(fixedPrefix("skills")).toEqual(["skills"]);
    expect(fixedPrefix("{name}")).toEqual([]);
  });
});

describe("placementPattern", () => {
  const pattern = placementPattern("plugins/{source}/{name}.md");

  test("reads back the variables expand wrote, and the root above them", () => {
    const vars = { source: "kit", name: "lint" };
    const path = join("/home/.claude", expand("plugins/{source}/{name}.md", vars));

    expect(pattern.match(path)).toEqual({ path, root: join("/home/.claude"), vars });
  });

  test("matches nothing of another shape, or with no root above it", () => {
    expect(pattern.match(join("/home", "plugins", "kit", "lint.txt"))).toBeUndefined();
    expect(pattern.match(join("/home", "skills", "kit", "lint.md"))).toBeUndefined();
    expect(pattern.match(join("plugins", "kit", "lint.md"))).toBeUndefined();
  });

  test("refuses a path that gives one variable two values", () => {
    const twice = placementPattern("{name}/{name}.md");
    expect(twice.match(join("/r", "lint", "lint.md"))?.vars).toEqual({ name: "lint" });
    expect(twice.match(join("/r", "lint", "fmt.md"))).toBeUndefined();
  });

  test("finds every path under a root it could have placed", async ({ tmp }) => {
    await mkdir(join(tmp, "plugins", "kit"), { recursive: true });
    await mkdir(join(tmp, "plugins", "kit", "lint.md"));
    await mkdir(join(tmp, "plugins", "kit", "notes.txt"));
    await mkdir(join(tmp, "plugins", "team", "fmt.md"), { recursive: true });

    const found = await pattern.scan(tmp);

    expect(
      found.map((each) => each.vars).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    ).toEqual([
      { source: "team", name: "fmt" },
      { source: "kit", name: "lint" },
    ]);
    expect(found.every((each) => each.root === tmp)).toBe(true);
  });
});
