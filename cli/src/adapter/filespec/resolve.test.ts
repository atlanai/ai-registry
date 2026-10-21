import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { type SpecArtifact, skillBody, writeSpecRoot } from "#test/kit/spec-root.ts";
import { canonicalize, contentDigest, sha256 } from "../spec/canonical.ts";
import { resolveFromRoot } from "./resolve.ts";

/** This test's folder, which the kit removes after it. */
let scratch: string;
test.beforeEach(({ tmp }) => {
  scratch = tmp;
});

/** Shares a name with `aireg/add`, and yanked its newest version. */
const OPS_ADD: SpecArtifact = {
  namespace: "ops",
  kind: "skill",
  name: "add",
  versions: [
    { version: "1.0.0", files: { "SKILL.md": skillBody("add") } },
    {
      version: "1.1.0",
      yanked: true,
      reason: "broke the build",
      files: { "SKILL.md": skillBody("add", "add", "1.1.0") },
    },
  ],
};

/** Blocked at its newest version, with nothing active to stand in as latest. */
const OPS_GATE: SpecArtifact = {
  namespace: "ops",
  kind: "skill",
  name: "gate",
  latest: "1.1.0",
  versions: [
    { version: "1.0.0", status: "deprecated", files: { "SKILL.md": skillBody("gate") } },
    {
      version: "1.1.0",
      status: "blocked",
      reason: "leaks tokens",
      files: { "SKILL.md": skillBody("gate", "gate", "1.1.0") },
    },
  ],
};

/** Waiting on review, so it has no release yet. */
const OPS_DRAFT: SpecArtifact = {
  namespace: "ops",
  kind: "skill",
  name: "draft",
  versions: [{ version: "0.1.0", status: "draft", files: { "SKILL.md": skillBody("draft") } }],
};

async function root(
  extra: readonly SpecArtifact[] = [],
  dir?: string,
): Promise<(path: string) => Promise<Uint8Array | undefined>> {
  const at = dir ?? (await mkdtemp(join(scratch, "aireg-spec-read-")));
  await writeSpecRoot(at, [
    {
      namespace: "aireg",
      kind: "skill",
      name: "add",
      versions: [{ version: "0.1.0", files: { "SKILL.md": skillBody("add") } }],
    },
    {
      namespace: "aireg",
      kind: "skill",
      name: "use",
      versions: [{ version: "0.1.0", status: "archived", files: { "SKILL.md": skillBody("use") } }],
    },
    ...extra,
  ]);
  return (path) => readFile(join(at, path)).catch(() => undefined);
}

describe("resolveFromRoot", () => {
  test("leaves an archived artifact out of a whole namespace", async () => {
    const read = await root();
    const { artifacts } = await resolveFromRoot(read, { blobUrl: "blobs", wanted: [], all: true });
    expect(artifacts.map((item) => item.envelope.metadata.name)).toEqual(["add"]);
  });

  test("holds a pin to the one artifact it names where two namespaces share the name", async () => {
    const read = await root([OPS_ADD]);
    const { artifacts } = await resolveFromRoot(read, {
      blobUrl: "blobs",
      wanted: [{ name: "add", namespace: "ops", kind: "skill", version: "1.0.0" }],
      all: true,
    });
    expect(artifacts.map((item) => item.id)).toEqual([
      "artifacts/aireg/skill/add/0.1.0",
      "artifacts/ops/skill/add/1.0.0",
    ]);
  });

  test("holds a pin narrowed by namespace alone to that namespace", async () => {
    const read = await root([OPS_ADD]);
    const { artifacts } = await resolveFromRoot(read, {
      blobUrl: "blobs",
      wanted: [{ name: "add", namespace: "ops", version: "1.0.0" }],
      all: true,
    });
    expect(artifacts.map((item) => item.id)).toEqual([
      "artifacts/aireg/skill/add/0.1.0",
      "artifacts/ops/skill/add/1.0.0",
    ]);
  });

  test("says which status a version installs with, and why", async () => {
    const read = await root([OPS_GATE, OPS_DRAFT]);
    const { artifacts } = await resolveFromRoot(read, {
      blobUrl: "blobs",
      wanted: [
        { name: "gate", namespace: "ops", kind: "skill", version: "1.0.0" },
        { name: "draft", namespace: "ops", kind: "skill", version: "0.1.0" },
        { name: "add", namespace: "aireg", kind: "skill" },
      ],
    });
    expect(artifacts.map((item) => [item.envelope.metadata.name, item.status])).toEqual([
      ["add", undefined],
      ["gate", { name: "deprecated", reason: undefined }],
      ["draft", { name: "draft", reason: undefined }],
    ]);
  });

  test("resolves a yanked version a pin names, and says why it was yanked", async () => {
    const read = await root([OPS_ADD]);
    const { artifacts } = await resolveFromRoot(read, {
      blobUrl: "blobs",
      wanted: [{ name: "add", namespace: "ops", kind: "skill", version: "1.1.0" }],
    });
    expect(artifacts.map((item) => [item.id, item.yanked])).toEqual([
      ["artifacts/ops/skill/add/1.1.0", { reason: "broke the build" }],
    ]);
  });

  test("names the newest version it holds where it served another, a yanked one included", async () => {
    const read = await root([OPS_ADD, OPS_GATE]);
    const listed = await resolveFromRoot(read, { blobUrl: "blobs", wanted: [], all: true });
    // The blocked gate is withheld at its newest version, which says it already.
    expect(
      [...(listed.newest ?? [])].sort((a, b) => a.namespace?.localeCompare(b.namespace ?? "") ?? 0),
    ).toEqual([
      { namespace: "aireg", kind: "skill", name: "use", version: "0.1.0" },
      { namespace: "ops", kind: "skill", name: "add", version: "1.1.0" },
    ]);
    const pinned = await resolveFromRoot(read, {
      blobUrl: "blobs",
      wanted: [{ name: "add", namespace: "ops", kind: "skill", version: "1.1.0" }],
    });
    expect(pinned.newest).toBeUndefined();
  });

  test("still installs an archived artifact asked for by name", async () => {
    const read = await root();
    const { artifacts } = await resolveFromRoot(read, {
      blobUrl: "blobs",
      wanted: [{ name: "use" }],
    });
    expect(artifacts.map((item) => item.envelope.metadata.name)).toEqual(["use"]);
  });

  test("withholds a blocked version even when pinned, and says why", async () => {
    const read = await root([OPS_GATE]);
    const resolved = await resolveFromRoot(read, {
      blobUrl: "blobs",
      wanted: [{ name: "gate", namespace: "ops", version: "1.1.0" }],
    });
    expect(resolved).toEqual({
      artifacts: [],
      withheld: [
        {
          namespace: "ops",
          kind: "skill",
          name: "gate",
          version: "1.1.0",
          status: "blocked",
          reason: "leaks tokens",
        },
      ],
    });
  });

  test("never takes a blocked latest for a request that does not pin it", async () => {
    const read = await root([OPS_GATE]);
    const resolved = await resolveFromRoot(read, { blobUrl: "blobs", wanted: [{ name: "gate" }] });
    expect(resolved.artifacts).toEqual([]);
    expect(resolved.withheld?.map((item) => [item.version, item.status])).toEqual([
      ["1.1.0", "blocked"],
    ]);
  });

  test("withholds a draft unless a pin names it", async () => {
    const read = await root([OPS_DRAFT]);
    const unpinned = await resolveFromRoot(read, { blobUrl: "blobs", wanted: [{ name: "draft" }] });
    expect(unpinned.artifacts).toEqual([]);
    expect(unpinned.withheld?.map((item) => item.status)).toEqual(["draft"]);
    const pinned = await resolveFromRoot(read, {
      blobUrl: "blobs",
      wanted: [{ name: "draft", version: "0.1.0" }],
    });
    expect(pinned.artifacts.map((item) => item.id)).toEqual(["artifacts/ops/skill/draft/0.1.0"]);
    expect(pinned.withheld).toBeUndefined();
  });

  test("verifies the envelope as written, fields it does not know included", async () => {
    const dir = await mkdtemp(join(scratch, "aireg-spec-read-"));
    const read = await root([], dir);
    const at = join(dir, "artifacts/aireg/skill/add/0.1.0/artifact.json");
    const raw = JSON.parse(await readFile(at, "utf8"));
    raw.x_future = { since: 2 };
    raw.files[0].annotations = { note: "kept" };
    const { digest: _digest, ...metadata } = raw.metadata;
    raw.metadata.digest = sha256(canonicalize({ ...raw, metadata }));
    await writeFile(at, JSON.stringify(raw));
    const versionsAt = join(dir, "artifacts/aireg/skill/add/versions.json");
    const versions = JSON.parse(await readFile(versionsAt, "utf8"));
    versions.versions[0].digest = raw.metadata.digest;
    await writeFile(versionsAt, JSON.stringify(versions));

    const { artifacts } = await resolveFromRoot(read, {
      blobUrl: "blobs",
      wanted: [{ name: "add" }],
    });

    expect(artifacts.map((item) => contentDigest(item.envelope))).toEqual([raw.metadata.digest]);
  });
});

describe("a registry document built to attack the terminal", () => {
  const TITLE = "\u001B]0;title\u0007";

  test("is named in an error with its escapes shown, not acted on", async () => {
    const read = await root();
    const hostile = async (path: string) => {
      const bytes = await read(path);
      if (path !== "index.json" || bytes === undefined) return bytes;
      const index = JSON.parse(new TextDecoder().decode(bytes));
      index.entries[0].name = `zz${TITLE}`;
      return new TextEncoder().encode(JSON.stringify(index));
    };
    const failed = resolveFromRoot(hostile, { blobUrl: "blobs", wanted: [], all: true });
    await expect(failed).rejects.toThrow(/lists "aireg\/skill\/zz\\u001b\]0;title\\u0007@0\.1\.0"/);
  });

  test("that is not JSON is refused without quoting its bytes", async () => {
    const read = async (path: string) =>
      path === "index.json" ? new TextEncoder().encode(`{"kind": x${TITLE}`) : undefined;
    const failed = resolveFromRoot(read, { blobUrl: "blobs", wanted: [], all: true });
    await expect(failed).rejects.toThrow(/^index\.json is not valid JSON\.$/);
  });
});
