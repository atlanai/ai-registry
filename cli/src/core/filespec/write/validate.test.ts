import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test as base, type Git } from "#test/kit/fixtures.ts";
import { validateRoot } from "./validate.ts";

type Builder = ReturnType<typeof registry>;

const AGENT = "---\nname: reviewer\ndescription: Reviews.\n---\nReview.\n";

/** A clean registry: a skill, and an agent that depends on it. */
function clean(root: string): Builder {
  return registry(root, { name: "team" })
    .skill("eng/lint@1.0.0", { description: "Lint it." })
    .agent("eng/reviewer@0.3.0", {
      description: "Reviews.",
      dependsOn: ["eng/skill/lint@1.0.0"],
      files: { "AGENT.md": AGENT },
    });
}

const test = base.extend("root", ({ tmp }) => join(tmp, "registry"));

/** A file under the root, made with its folders. */
async function put(root: string, path: string, body: string): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), body);
}

interface Case {
  /** What a pull request got wrong. */
  name: string;
  build?: (registry: Builder) => Builder;
  edit?: (root: string) => Promise<unknown>;
  path: string;
  message: string;
}

const CASES: Case[] = [
  {
    name: "a missing index",
    edit: (root) => rm(join(root, "index.json")),
    path: "index.json",
    message: "is missing",
  },
  {
    name: "an index that is not JSON",
    edit: (root) => writeFile(join(root, "index.json"), "{"),
    path: "index.json",
    message: "is not valid JSON",
  },
  {
    name: "a registry that does not serve files",
    edit: async (root) => {
      const document = JSON.parse(await readFile(join(root, "registry.json"), "utf8"));
      await writeFile(
        join(root, "registry.json"),
        JSON.stringify({ ...document, capabilities: [] }),
      );
    },
    path: "registry.json",
    message: 'capabilities must include "files"',
  },
  {
    name: "a folder the path grammar refuses",
    edit: (root) =>
      mkdir(join(root, "artifacts", "Eng!", "skill", "x", "1.0.0"), { recursive: true }),
    path: "artifacts/Eng!",
    message: "is not a namespace",
  },
  {
    name: "a name Windows keeps for a device",
    edit: (root) =>
      mkdir(join(root, "artifacts", "eng", "skill", "lpt9", "1.0.0"), { recursive: true }),
    path: "artifacts/eng/skill/lpt9",
    message: "is a device name on Windows",
  },
  {
    name: "a kind the registry does not hold",
    edit: (root) => put(root, "artifacts/eng/tool/x/1.0.0/a.md", "x"),
    path: "artifacts/eng/tool/x/1.0.0",
    message: '"tool" is not a kind this registry holds',
  },
  {
    name: "a version without its kind's entry file",
    edit: (root) => put(root, "artifacts/eng/skill/fmt/1.0.0/notes.md", "x"),
    path: "artifacts/eng/skill/fmt/1.0.0",
    message: "has no SKILL.md",
  },
  {
    name: "front matter that names another artifact",
    edit: (root) =>
      put(
        root,
        "artifacts/eng/skill/fmt/1.0.0/SKILL.md",
        "---\nname: other\ndescription: d\n---\n",
      ),
    path: "artifacts/eng/skill/fmt/1.0.0",
    message: 'is named "other" in its front matter',
  },
  {
    name: "a dependency the registry does not hold",
    build: (registry) =>
      registry.agent("eng/helper@1.0.0", {
        dependsOn: ["eng/skill/gone@1.0.0"],
        files: { "AGENT.md": AGENT.replace("name: reviewer", "name: helper") },
      }),
    path: "artifacts/eng/agent/helper/1.0.0",
    message: "depends on eng/skill/gone@1.0.0, which this registry does not hold",
  },
  {
    name: "a released file edited in place",
    edit: (root) =>
      put(
        root,
        "artifacts/eng/skill/lint/1.0.0/SKILL.md",
        "---\nname: lint\ndescription: x\n---\n",
      ),
    path: "artifacts/eng/skill/lint/1.0.0/SKILL.md",
    message: "changed since 1.0.0 was released",
  },
  {
    name: "a file path that would make the version a repository",
    edit: async (root) => {
      const at = join(root, "artifacts/eng/skill/lint/1.0.0/artifact.json");
      const envelope = JSON.parse(await readFile(at, "utf8"));
      envelope.files.push({ path: ".git/config", digest: `sha256:${"0".repeat(64)}`, size: 0 });
      await writeFile(at, JSON.stringify(envelope));
    },
    path: "artifacts/eng/skill/lint/1.0.0/artifact.json",
    message: 'describes ".git/config", which is not a path inside the artifact',
  },
  {
    name: "a kind manifest the registry serves that does not parse",
    edit: async (root) => {
      const document = JSON.parse(await readFile(join(root, "registry.json"), "utf8"));
      const kinds = [{ name: "skill", manifest_url: "kinds/skill.json" }, { name: "agent" }];
      await writeFile(join(root, "registry.json"), JSON.stringify({ ...document, kinds }));
      await put(root, "kinds/skill.json", "{");
    },
    path: "kinds/skill.json",
    message: 'is not valid JSON, so "skill" is checked against the one aireg bundles',
  },
  {
    name: "a released version folder deleted",
    edit: (root) => rm(join(root, "artifacts/eng/agent/reviewer/0.3.0"), { recursive: true }),
    path: "artifacts/eng/agent/reviewer/0.3.0",
    message: "is missing, but versions.json lists 0.3.0",
  },
  {
    name: "an index row for an artifact deleted",
    edit: (root) => rm(join(root, "artifacts/eng/agent/reviewer"), { recursive: true }),
    path: "index.json",
    message: "lists eng/agent/reviewer, which has no versions.json",
  },
  {
    name: "a catalog digest that does not cover its row",
    edit: async (root) => {
      const at = join(root, "artifacts/eng/skill/lint/versions.json");
      const document = JSON.parse(await readFile(at, "utf8"));
      document.versions[0].catalog_digest = `sha256:${"0".repeat(64)}`;
      await writeFile(at, JSON.stringify(document));
    },
    path: "artifacts/eng/skill/lint/versions.json",
    message: `catalog_digest of 1.0.0 is sha256:${"0".repeat(64)}, but its row and envelope give`,
  },
  {
    name: "a symlink in a version",
    edit: (root) => symlink("/etc/hosts", join(root, "artifacts/eng/skill/lint/1.0.0/hosts")),
    path: "artifacts/eng/skill/lint/1.0.0/hosts",
    message: "is a symlink",
  },
];

describe("validateRoot", () => {
  test("finds nothing wrong with a registry written to the spec", async ({ root }) => {
    const validated = await validateRoot(await clean(root).write());

    expect(validated).toMatchObject({ name: "team", namespaces: 1, artifacts: 2, versions: 2 });
    expect(validated.problems).toEqual([]);
  });

  test("keeps taking an agent released with a runtime block", async ({ root }) => {
    const agent =
      "---\nname: reviewer\ndescription: Reviews.\nruntime:\n  harness: claude-code\n---\nReview.\n";
    await registry(root, { name: "team" })
      .agent("eng/reviewer@0.3.0", { description: "Reviews.", files: { "AGENT.md": agent } })
      .write();

    expect((await validateRoot(root)).problems).toEqual([]);
  });

  test.for(CASES)("names $name", async (each, { root }) => {
    await (each.build ?? ((registry) => registry))(clean(root)).write();
    await each.edit?.(root);

    const { problems } = await validateRoot(root);

    expect(problems).toContainEqual(
      expect.objectContaining({ path: each.path, message: expect.stringContaining(each.message) }),
    );
  });
});

const ACME = join(dirname(fileURLToPath(import.meta.url)), "../../../../../examples/acme-registry");
const RUBRIC_BLOB = "blobs/sha256/28eb2235f00fa89d30904eb6e4a3625dca764a66a67aa9d55c56218c5138fc0c";

describe("validateRoot on blob storage", () => {
  test("names the blob, not the version, when a released blob is gone", async ({ root }) => {
    await cp(ACME, root, { recursive: true });
    await rm(join(root, RUBRIC_BLOB));

    const { problems } = await validateRoot(root);

    expect(problems).toContainEqual({
      path: RUBRIC_BLOB,
      message: "is missing, but pr-review 1.2.0 keeps assets/rubric.json there",
      fix: "restore the blob, or point blob_url in registry.json at where it is",
    });
  });

  test("leaves a blob on another host to whoever fetches it", async ({ root }) => {
    await cp(ACME, root, { recursive: true });
    const at = join(root, "registry.json");
    const document = JSON.parse(await readFile(at, "utf8"));
    document.blob_url = "https://cdn.example.com/blobs/sha256/{digest}";
    await writeFile(at, JSON.stringify(document));

    expect((await validateRoot(root)).problems).toEqual([]);
  });

  test("checks the catalog digests the example registry carries", async ({ root }) => {
    await cp(ACME, root, { recursive: true });

    expect((await validateRoot(root)).problems).toEqual([]);
  });
});

describe("validateRoot against a base", () => {
  const LINT = "artifacts/eng/skill/lint";

  const WITHDRAW = 'to withdraw a release, set "yanked": true in its versions.json instead';

  async function released(root: string, git: Git): Promise<string> {
    await registry(root, { name: "team" })
      .skill("eng/lint@1.0.0", { description: "Lint it." })
      .skill("eng/lint@1.1.0", { description: "Lint it more." })
      .write();
    await git.init(root);
    return git.commit(root, "release");
  }

  async function rewrite(root: string, change: (document: { versions: unknown[] }) => unknown) {
    const at = join(root, LINT, "versions.json");
    const document = JSON.parse(await readFile(at, "utf8"));
    await writeFile(at, JSON.stringify(change(document) ?? document));
  }

  test("reads a compact versions.json in the base like any other", async ({ root, git }) => {
    await registry(root, { name: "team" }).skill("eng/lint@1.0.0").write();
    await rewrite(root, () => undefined);
    await git.init(root);
    const base = await git.commit(root, "release");
    await put(root, `${LINT}/1.0.0/SKILL.md`, "---\nname: lint\ndescription: x\n---\n");

    const { problems } = await validateRoot(root, { base });

    expect(problems).toContainEqual(
      expect.objectContaining({
        path: `${LINT}/1.0.0/SKILL.md`,
        message: "changed since 1.0.0 was released",
        fix: `aireg skill bump lint --namespace eng && git checkout ${base} -- ${LINT}/1.0.0 && aireg registry index`,
      }),
    );
  });

  test("restores an older release first, since a bump copies only the newest", async ({
    root,
    git,
  }) => {
    const base = await released(root, git);
    await put(root, `${LINT}/1.0.0/SKILL.md`, "---\nname: lint\ndescription: x\n---\n");

    expect((await validateRoot(root, { base })).problems).toContainEqual({
      path: `${LINT}/1.0.0/SKILL.md`,
      message: "changed since 1.0.0 was released",
      fix: `git checkout ${base} -- ${LINT}/1.0.0, then make the change in a new version: aireg skill bump lint --namespace eng`,
    });
  });

  test("accepts rows in another order", async ({ root, git }) => {
    const base = await released(root, git);
    await rewrite(root, (document) => {
      document.versions.reverse();
    });

    expect((await validateRoot(root, { base })).problems).toEqual([]);
  });

  test("refuses to delete a released version", async ({ root, git }) => {
    const base = await released(root, git);
    await rm(join(root, LINT, "1.0.0"), { recursive: true });

    expect((await validateRoot(root, { base })).problems).toContainEqual({
      path: `${LINT}/1.0.0`,
      message: "is missing, but versions.json lists 1.0.0",
      fix: `restore ${LINT}/1.0.0/, or if 1.0.0 was never released, remove it from versions.json`,
    });
  });

  test("refuses to delete a released artifact", async ({ root, git }) => {
    const base = await released(root, git);
    await rm(join(root, LINT), { recursive: true });

    const { problems } = await validateRoot(root, { base });

    expect(problems).toContainEqual({
      path: `${LINT}/versions.json`,
      message: "is missing, but 1.0.0 was released",
      fix: `git checkout ${base} -- ${LINT}; ${WITHDRAW}`,
    });
    expect(problems).toContainEqual({
      path: `${LINT}/versions.json`,
      message: "is missing, but 1.1.0 was released",
      fix: `git checkout ${base} -- ${LINT}; ${WITHDRAW}`,
    });
  });

  test("refuses to drop a released row", async ({ root, git }) => {
    const base = await released(root, git);
    await rewrite(root, (document) => {
      document.versions = document.versions.filter(
        (row) => (row as { version: string }).version !== "1.0.0",
      );
    });

    expect((await validateRoot(root, { base })).problems).toContainEqual({
      path: `${LINT}/versions.json`,
      message: "no longer lists 1.0.0, which was released",
    });
  });
});
