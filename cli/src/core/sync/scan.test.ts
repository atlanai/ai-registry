import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { KIND_SPECS } from "#core/kinds.ts";
import { test } from "#test/kit/fixtures.ts";
import { entriesIn } from "./scan.ts";

let root: string;

test.beforeEach(async ({ tmp }) => {
  root = tmp;
});
async function folder(path: string, files: Record<string, string> = {}): Promise<void> {
  await mkdir(join(root, path), { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(root, path, name), body);
}

describe("entriesIn", () => {
  test("takes a directory only when it holds the entry file its kind declares", async () => {
    await folder("skills/mine", { "SKILL.md": "---\nname: mine\ndescription: Mine.\n---\n" });
    await folder("skills/synced/bucket/theirs", { "SKILL.md": "---\nname: theirs\n---\n" });
    const found = await entriesIn(
      root,
      join(root, "skills"),
      { kind: "skill", ...KIND_SPECS.skill },
      undefined,
    );
    expect(found.map((entry) => [entry.name, entry.description])).toEqual([["mine", "Mine."]]);
  });

  test("checks the entry a kind declares, and lists every directory when it declares none", async () => {
    await folder("plugins/kit", { "MANIFEST.md": "---\nname: kit\n---\n" });
    await folder("plugins/loose");
    const spec = { kind: "plugin" as const, shape: "directory" as const, extensions: [] };

    const declared = await entriesIn(
      root,
      join(root, "plugins"),
      { ...spec, entry: "MANIFEST.md" },
      undefined,
    );
    expect(declared.map((entry) => entry.name)).toEqual(["kit"]);

    const undeclared = await entriesIn(root, join(root, "plugins"), spec, undefined);
    expect(undeclared.map((entry) => entry.name)).toEqual(["kit", "loose"]);
  });
});
