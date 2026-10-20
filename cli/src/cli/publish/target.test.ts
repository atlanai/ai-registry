import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import { offerFrom } from "#core/filespec/write/offer.ts";
import { test } from "#test/kit/fixtures.ts";
import { commitAndPush, folderTo, type Published, parseTo, plan } from "./target.ts";
import type { Work } from "./work.ts";

vi.mock("#core/filespec/write/offer.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#core/filespec/write/offer.ts")>();
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
    } as unknown as Published;

    const planned = await plan(work, published, "eng", "minor", undefined, false);
    expect(planned.version).toBe("1.3.0");
    expect(planned.input.version).toBe("1.3.0");
    expect(planned.input.files.map((file) => file.path).sort()).toEqual(["SKILL.md", "model.bin"]);
    expect(offerFrom).toHaveBeenCalledTimes(1);
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
  test("takes one version, never a range", async () => {
    expect(parseTo("acme/eng/skill/lint@1.2.0").version).toBe("1.2.0");
    expect(() => parseTo("acme/eng/skill/lint@^1.2")).toThrow(
      '--to "acme/eng/skill/lint@^1.2" names a version range, not a version.',
    );
    await mkdir(join(root, "registry"), { recursive: true });
    await writeFile(join(root, "registry", "registry.json"), "{}");
    await expect(folderTo(join(root, "registry", "eng", "skill", "lint@~1"), root)).rejects.toThrow(
      "names a version range, not a version.",
    );
  });
});
