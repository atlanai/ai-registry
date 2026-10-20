import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import type { PublishInput, SourceContext } from "#adapter/index.ts";
import { skillsFolder } from "#test/kit/builders/layouts.ts";
import { test } from "#test/kit/fixtures.ts";
import { connect } from "./connect.ts";

const body = (text: string) => new TextEncoder().encode(text);

/** The smallest root the reader accepts: a registry document and an empty catalog. */
async function emptyRoot(dir: string): Promise<void> {
  await writeFile(
    join(dir, "registry.json"),
    `${JSON.stringify(
      {
        kind: "registry",
        format_version: 1,
        name: "mine",
        capabilities: ["files"],
        auth: { type: "none" },
        blob_url: "blobs/sha256/{digest}",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(dir, "index.json"),
    `${JSON.stringify({ format_version: 1, generated_at: "2026-01-01T00:00:00Z", entries: [] })}\n`,
  );
}

function context(root: string): SourceContext {
  return {
    source: { registry: "mine", location: root, config: {}, key: "sha256:k" },
    credential: undefined,
    signal: new AbortController().signal,
    limits: { timeoutMs: 1000, retries: 0 },
    onBytes: () => {},
    cacheDir: () => "",
    exclusive: (_key, run) => run(),
  };
}

function scout(text = "One.\n"): PublishInput {
  return {
    name: "scout",
    kind: "skill",
    namespace: "mine",
    version: "0.1.0",
    description: "Looks around.",
    contentId: "sha256:unused-here",
    files: [
      { path: "SKILL.md", content: body(`---\nname: scout\n---\n${text}`), executable: false },
    ],
  };
}

let root: string;
test.beforeEach(async ({ tmp }) => {
  root = tmp;
  await emptyRoot(root);
});
describe("local publish", () => {
  test("writes in place and the same handle resolves it straight after", async () => {
    const handle = await connect(context(root));
    if (handle.publish === undefined) throw new Error("local adapter declares no publish");

    const result = await handle.publish([scout()], {});
    expect(result.unchanged).not.toBe(true);
    expect(result.location).toBe(root);

    // No branch, no indexer: the root is already what a consumer reads.
    const resolution = await handle.resolve([]);
    expect(resolution.artifacts).toHaveLength(1);
    // The id is the path under the root - namespace, kind, name and version in
    // one string - which is exactly where the writer put it.
    expect(resolution.artifacts[0]).toMatchObject({
      kind: "skill",
      id: "artifacts/mine/skill/scout/0.1.0",
    });

    const index = JSON.parse(await readFile(join(root, "index.json"), "utf8")) as {
      entries: { name: string; latest: string }[];
    };
    expect(index.entries).toEqual([expect.objectContaining({ name: "scout", latest: "0.1.0" })]);
    await expect(
      readFile(join(root, "artifacts/mine/skill/scout/versions.json")),
    ).resolves.toBeDefined();
  });

  test("offers identical bytes as unchanged without touching the documents", async () => {
    const handle = await connect(context(root));
    if (handle.publish === undefined) throw new Error("local adapter declares no publish");
    await handle.publish([scout()], {});
    const before = await readFile(join(root, "index.json"), "utf8");

    const again = await handle.publish([scout()], {});

    expect(again.unchanged).toBe(true);
    expect(await readFile(join(root, "index.json"), "utf8")).toBe(before);
  });

  test("refuses a namespace that would leave the root, as this adapter's own error", async () => {
    const handle = await connect(context(root));
    if (handle.publish === undefined) throw new Error("local adapter declares no publish");

    await expect(
      handle.publish([{ ...scout(), namespace: "../escape" }], {}),
    ).rejects.toMatchObject({
      adapter: "local",
      failure: "invalid",
    });
  });
});

describe("local connect", () => {
  test("reports a file spec refusal as its own failure, with the reader's hint", async () => {
    await rm(join(root, "registry.json"));
    const handle = await connect(context(root));
    await expect(handle.resolve([])).rejects.toMatchObject({
      adapter: "local",
      failure: "invalid",
      hint: expect.stringContaining("registry init"),
    });
  });

  test("says a folder that is not there does not exist", async () => {
    await expect(connect(context(join(root, "gone")))).rejects.toMatchObject({
      adapter: "local",
      failure: "not_found",
      message: expect.stringContaining("does not exist"),
    });
  });
});

describe("a local folder of skills", () => {
  test("is read, named after the folder, with no versions", async ({ tmp }) => {
    const kit = await skillsFolder(join(tmp, "kit")).skill("skills/pdf").write();
    const handle = await connect(context(kit));
    const resolution = await handle.resolve([]);
    expect(resolution.layout).toBe("folder");
    expect(resolution.artifacts.map((item) => [item.group, item.id, item.version])).toEqual([
      ["kit", "skills/pdf", undefined],
    ]);
    await expect(handle.resolve([{ name: "pdf", version: "1.0.0" }])).rejects.toMatchObject({
      adapter: "local",
      failure: "invalid",
      message:
        "mine is a folder of skills, which has no versions, so pdf@1.0.0 cannot be installed.",
    });
  });

  test("refuses a publish before writing anything", async ({ tmp }) => {
    const kit = await skillsFolder(join(tmp, "kit")).skill("skills/pdf").write();
    const handle = await connect(context(kit));
    await expect(handle.publish?.([scout()], {})).rejects.toMatchObject({
      adapter: "local",
      message:
        "mine is a folder of skills, not a registry, so aireg reads it but does not publish to it.",
    });
    await expect(readFile(join(kit, "index.json"))).rejects.toThrow(/ENOENT/);
  });
});
