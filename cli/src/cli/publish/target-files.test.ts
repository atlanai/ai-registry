import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { offerFrom } from "#core/filespec/write/offer.ts";
import { test } from "#test/kit/fixtures.ts";
import { type Published, plan } from "./target.ts";
import type { Work } from "./work.ts";

async function fixture(root: string, mapped = false) {
  const path = join(root, "reviewer");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "AGENT.md"), "---\nname: reviewer\ndescription: Reviews code.\n---\n");
  await writeFile(join(path, "one.md"), "First.\n");
  await writeFile(join(path, "two.md"), "Second.\n");
  const work: Work = {
    name: "reviewer",
    kind: "agent",
    path,
    description: undefined,
    home: undefined,
    row: undefined,
    base: undefined,
    ...(mapped
      ? {
          exported: {
            path: "reviewer",
            version: undefined,
            dependsOn: [],
            publish: undefined,
            files: [
              { from: "AGENT.md", as: "AGENT.md" },
              { from: "one.md", as: "old.md" },
            ],
          },
        }
      : {}),
  };
  const { files, digests } = await offerFrom(path, {
    name: work.name,
    kind: work.kind,
    version: "0.1.0",
    files: work.exported?.files,
  });
  const current = { id: "reviewer", version: "0.1.0", files, digests };
  const published = {
    alias: "acme",
    source: { adapter: { id: "probe", capabilities: { agentFolders: true } } },
    latest: new Map([["eng/agent/reviewer", current]]),
    withheld: new Map(),
  } as unknown as Published;
  return { work, current, published };
}

const planned = (work: Work, published: Published) =>
  plan(work, published, "eng", "patch", undefined, false);

describe("publish file identity", () => {
  test("publishes a path-only rename as a removal and an addition", async ({ tmp }) => {
    const { work, published } = await fixture(tmp);
    await rename(join(work.path, "one.md"), join(work.path, "renamed.md"));
    const next = await planned(work, published);
    expect(next).toMatchObject({ same: false, version: "0.1.1" });
    expect(next.changes?.files).toEqual({
      added: ["renamed.md"],
      changed: [],
      removed: ["one.md"],
    });
  });

  test("publishes an include mapping's destination change", async ({ tmp }) => {
    const { work, published } = await fixture(tmp, true);
    const files = work.exported?.files?.map((file) =>
      file.as === "old.md" ? { ...file, as: "new.md" } : file,
    );
    work.exported = {
      path: "reviewer",
      version: undefined,
      dependsOn: [],
      publish: undefined,
      files,
    };
    const next = await planned(work, published);
    expect(next).toMatchObject({ same: false, version: "0.1.1" });
    expect(next.changes?.files).toEqual({ added: ["new.md"], changed: [], removed: ["old.md"] });
  });

  test("publishes swapped contents even when the set of digests is unchanged", async ({ tmp }) => {
    const { work, published } = await fixture(tmp);
    await writeFile(join(work.path, "one.md"), "Second.\n");
    await writeFile(join(work.path, "two.md"), "First.\n");
    const next = await planned(work, published);
    expect(next).toMatchObject({ same: false, version: "0.1.1" });
    expect(next.changes?.files).toEqual({ added: [], changed: ["one.md", "two.md"], removed: [] });
  });

  test("keeps a native single-file agent unchanged when its registry calls the entry AGENT.md", async ({
    tmp,
  }) => {
    const { work, current, published } = await fixture(tmp);
    work.path = join(tmp, "reviewer.md");
    await writeFile(work.path, "---\nname: reviewer\ndescription: Reviews code.\n---\n");
    const { files, digests } = await offerFrom(work.path, {
      name: work.name,
      kind: "agent",
      version: "0.1.0",
    });
    current.files = files.map((file) => ({ ...file, path: "AGENT.md" }));
    current.digests = digests;
    expect(await planned(work, published)).toMatchObject({ same: true, version: "0.1.0" });
    work.exported = { path: "reviewer.md", version: "0.1.0", dependsOn: [], publish: undefined };
    expect(await planned(work, published)).toMatchObject({ same: true, version: "0.1.0" });
  });

  test("keeps single-file skill paths significant", async ({ tmp }) => {
    const path = join(tmp, "lint");
    await mkdir(path);
    await writeFile(join(path, "SKILL.md"), "---\nname: lint\ndescription: Lints code.\n---\n");
    const { work, published } = await fixture(tmp);
    work.path = path;
    work.kind = "skill";
    work.name = "lint";
    const { files, digests } = await offerFrom(path, {
      name: "lint",
      kind: "skill",
      version: "0.1.0",
    });
    published.latest.set("eng/skill/lint", {
      id: "lint",
      version: "0.1.0",
      digests,
      files: files.map((file) => ({ ...file, path: "old.md" })),
    });
    expect(await planned(work, published)).toMatchObject({ same: false, version: "0.1.1" });
  });

  test("ignores descriptor order", async ({ tmp }) => {
    const { work, current, published } = await fixture(tmp);
    current.files.reverse();
    expect(await planned(work, published)).toMatchObject({ same: true, version: "0.1.0" });
  });

  test("keeps digest comparison when an older snapshot gives no file paths", async ({ tmp }) => {
    const { work, current, published } = await fixture(tmp);
    const { files: _, ...withoutFiles } = current;
    published.latest.set("eng/agent/reviewer", withoutFiles);
    expect(await planned(work, published)).toMatchObject({ same: true, version: "0.1.0" });
    await writeFile(join(work.path, "one.md"), "Changed.\n");
    expect(await planned(work, published)).toMatchObject({ same: false, version: "0.1.1" });
  });

  for (const version of ["0.1.0", "0.0.9"]) {
    test(`refuses changed paths at a fixed export version ${version}`, async ({ tmp }) => {
      const { work, current, published } = await fixture(tmp);
      work.exported = { path: "reviewer", version, dependsOn: [], publish: undefined };
      published.source.handle = {
        resolve: async () => ({
          artifacts: [
            {
              id: "reviewer",
              kind: "agent",
              envelope: { metadata: { version }, files: current.files },
            },
          ],
        }),
      } as unknown as Published["source"]["handle"];
      await rename(join(work.path, "one.md"), join(work.path, "renamed.md"));
      await expect(planned(work, published)).rejects.toMatchObject({ code: "conflict" });
    });
  }
});
