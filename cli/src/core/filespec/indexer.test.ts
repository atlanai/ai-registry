import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, vi } from "vitest";
import { contentDigest } from "#adapter/spec/canonical.ts";
import { validateRoot } from "#core/filespec/validate/validate.ts";
import { test } from "#test/kit/fixtures.ts";
import { indexRoot } from "./indexer.ts";

const held = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      held.paths.push(String(args[0]));
      return actual.readFile(...args);
    },
  };
});

vi.mock("#adapter/files.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#adapter/files.ts")>();
  return {
    ...actual,
    readRegular: (root: string, path: string) => {
      held.paths.push(join(root, path));
      return actual.readRegular(root, path);
    },
  };
});

const ACME = join(dirname(fileURLToPath(import.meta.url)), "../../../../examples/acme-registry");

let root: string;

test.beforeEach(async ({ tmp }) => {
  root = tmp;
  await cp(ACME, root, { recursive: true });
  held.paths = [];
});

describe("indexRoot", () => {
  test("digests a large asset as it streams past, holding only what the spec is read from", async () => {
    const version = join(root, "artifacts", "engineering", "skill", "pr-review", "1.3.0");
    await mkdir(version, { recursive: true });
    await writeFile(
      join(version, "SKILL.md"),
      "---\nname: pr-review\ndescription: Reviews pull requests.\n---\n\nReview it.\n",
    );
    const model = Buffer.alloc(256 * 1024, 7);
    await writeFile(join(version, "model.bin"), model);

    const indexed = await indexRoot(root, "2026-10-08T00:00:00Z");

    expect(indexed.added.map((offered) => offered.version)).toEqual(["1.3.0"]);
    const envelope = JSON.parse(await readFile(join(version, "artifact.json"), "utf8"));
    expect(envelope.metadata.description).toBe("Reviews pull requests.");
    expect(envelope.files).toContainEqual({
      path: "model.bin",
      digest: `sha256:${createHash("sha256").update(model).digest("hex")}`,
      size: model.byteLength,
      urls: ["model.bin"],
    });
    expect(held.paths.filter((path) => path.endsWith("model.bin"))).toEqual([]);
  });

  const RUBRIC = {
    path: "assets/rubric.json",
    digest: "sha256:28eb2235f00fa89d30904eb6e4a3625dca764a66a67aa9d55c56218c5138fc0c",
    size: 116,
    media_type: "application/json",
  };

  async function nextVersion(files: unknown[]): Promise<string> {
    const version = join(root, "artifacts", "engineering", "skill", "pr-review", "1.3.0");
    await mkdir(version, { recursive: true });
    await writeFile(
      join(version, "SKILL.md"),
      "---\nname: pr-review\ndescription: Reviews pull requests.\n---\n\nReview it.\n",
    );
    await writeFile(join(version, "artifact.json"), JSON.stringify({ files }));
    return version;
  }

  test("keeps a file the envelope holds in the blob store", async () => {
    const version = await nextVersion([RUBRIC]);

    await indexRoot(root, "2026-10-08T00:00:00Z");

    const envelope = JSON.parse(await readFile(join(version, "artifact.json"), "utf8"));
    expect(envelope.files.map((file: { path: string }) => file.path)).toEqual([
      "SKILL.md",
      "assets/rubric.json",
    ]);
    expect(envelope.files[1]).toEqual(RUBRIC);
  });

  test("keeps the relationships a hand-written artifact.json gives, inside the digest", async () => {
    const edge = {
      rel_type: "depends_on",
      to: "engineering/skill/pr-review@1.2.0",
    };
    const version = join(root, "artifacts", "engineering", "skill", "pr-review", "1.3.0");
    await mkdir(version, { recursive: true });
    await writeFile(
      join(version, "SKILL.md"),
      "---\nname: pr-review\ndescription: Reviews pull requests.\n---\n\nReview it.\n",
    );
    await writeFile(join(version, "artifact.json"), JSON.stringify({ relationships: [edge] }));

    await indexRoot(root, "2026-10-08T00:00:00Z");

    const envelope = JSON.parse(await readFile(join(version, "artifact.json"), "utf8"));
    expect(envelope.relationships).toEqual([edge]);
    const { digest, ...metadata } = envelope.metadata;
    expect(digest).toBe(contentDigest({ ...envelope, metadata }));
    expect(digest).not.toBe(contentDigest({ ...envelope, metadata, relationships: undefined }));
  });

  test("refuses to keep a blob-backed file whose blob is not there", async () => {
    await nextVersion([{ ...RUBRIC, digest: `sha256:${"0".repeat(64)}` }]);

    await expect(indexRoot(root, "2026-10-08T00:00:00Z")).rejects.toThrow(
      `artifacts/engineering/skill/pr-review/1.3.0/artifact.json keeps assets/rubric.json in the blob store, but blobs/sha256/${"0".repeat(64)} is missing.`,
    );
  });

  test("lists a new version above the ones before it", async () => {
    await nextVersion([]);

    await indexRoot(root, "2026-10-08T00:00:00Z");

    const versions = JSON.parse(
      await readFile(
        join(root, "artifacts", "engineering", "skill", "pr-review", "versions.json"),
        "utf8",
      ),
    );
    expect(versions.versions.map((row: { version: string }) => row.version)).toEqual([
      "1.3.0",
      "1.2.0",
      "1.1.0",
    ]);
  });

  test("records the whole description, however long", async () => {
    const long = `${"Reviews pull requests for correctness and clarity. ".repeat(8).trim()}`;
    const version = join(root, "artifacts", "engineering", "skill", "pr-review", "1.3.0");
    await mkdir(version, { recursive: true });
    await writeFile(join(version, "SKILL.md"), `---\nname: pr-review\ndescription: ${long}\n---\n`);

    await indexRoot(root, "2026-10-08T00:00:00Z");

    const envelope = JSON.parse(await readFile(join(version, "artifact.json"), "utf8"));
    expect(envelope.metadata.description).toBe(long);
    const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
    expect(
      index.entries.find((row: { name: string }) => row.name === "pr-review").description,
    ).toBe(long);
  });

  test("carries a status change into index.json when no other version is active", async () => {
    const at = join(root, "artifacts", "engineering", "skill", "pr-review", "versions.json");
    const versions = JSON.parse(await readFile(at, "utf8"));
    versions.versions[0].status = "deprecated";
    await writeFile(at, JSON.stringify(versions));

    await indexRoot(root, "2026-10-08T00:00:00Z");

    const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
    const row = index.entries.find((entry: { name: string }) => entry.name === "pr-review");
    expect(row).toMatchObject({ latest: "1.2.0", status: "deprecated" });
  });

  test("recomputes the catalog digest a yank moves", async () => {
    const path = "artifacts/engineering/skill/pr-review/versions.json";
    const at = join(root, path);
    const versions = JSON.parse(await readFile(at, "utf8"));
    Object.assign(versions.versions[0], { yanked: true, reason: "Flags false positives." });
    await writeFile(at, JSON.stringify(versions));
    expect((await validateRoot(root)).problems).toEqual([
      expect.objectContaining({ path, fix: "aireg registry index" }),
    ]);

    await indexRoot(root, "2026-10-08T00:00:00Z");

    expect((await validateRoot(root)).problems).toEqual([]);
    const rows = JSON.parse(await readFile(at, "utf8")).versions;
    const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
    expect(
      index.entries.find((entry: { name: string }) => entry.name === "pr-review"),
    ).toMatchObject({ latest: "1.2.0", catalog_digest: rows[0].catalog_digest });
  });

  test("drops the catalog digest of the version a new one replaces as latest", async () => {
    await nextVersion([]);

    await indexRoot(root, "2026-10-08T00:00:00Z");

    const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
    const row = index.entries.find((entry: { name: string }) => entry.name === "pr-review");
    expect(row.latest).toBe("1.3.0");
    expect(row).not.toHaveProperty("catalog_digest");
  });

  test("drops the row of an artifact whose folder was deleted", async () => {
    await rm(join(root, "artifacts", "engineering", "agent", "reviewer"), { recursive: true });

    await indexRoot(root, "2026-10-08T00:00:00Z");

    const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
    expect(index.entries.map((entry: { name: string }) => entry.name)).toEqual(["pr-review"]);
    expect(index.generated_at).toBe("2026-10-08T00:00:00Z");
  });
});
