import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import {
  describeFile,
  type PublishInput,
  type ReadPath,
  readIndex,
  readVersions,
  rootReader,
  SpecError,
  sha256,
} from "#adapter/index.ts";
import { test } from "#test/kit/fixtures.ts";
import { writeOffer } from "./publish.ts";

/** No other process writes these folders, so the lease is the run itself. */
const alone = <T>(_key: string, run: () => Promise<T>) => run();

const body = (text: string) => new TextEncoder().encode(text);

function offer(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    name: "lint",
    kind: "skill",
    namespace: "house",
    version: "1.0.0",
    description: "Lint it.",
    contentId: "sha256:unused-here",
    files: [{ path: "SKILL.md", content: body("---\nname: lint\n---\nOne.\n"), executable: false }],
    ...overrides,
  };
}

let root: string;
test.beforeEach(async ({ tmp }) => {
  root = tmp;
});
/** The same reader the adapters use, so what was written is what gets read. */
function read(dir: string): ReadPath {
  return rootReader(dir);
}

/** The digest the written envelope pins, which both generated documents must repeat. */
async function pinned(version: string): Promise<string> {
  const envelope = JSON.parse(
    await readFile(join(root, `artifacts/house/skill/lint/${version}/artifact.json`), "utf8"),
  ) as { metadata: { digest: string } };
  return envelope.metadata.digest;
}

describe("writeOffer", () => {
  test("writes the version directory, its envelope and both generated documents", async () => {
    const written = await writeOffer(root, [offer()], "2026-01-02T00:00:00Z", alone);

    expect(written.unchanged).toBe(false);

    const versions = await readVersions(read(root), "house", "skill", "lint");
    expect(versions.latest).toBe("1.0.0");
    const digest = await pinned("1.0.0");
    expect(versions.versions[0]?.digest).toBe(digest);

    const [entry] = await readIndex(read(root));
    expect(entry).toMatchObject({
      namespace: "house",
      kind: "skill",
      name: "lint",
      latest: "1.0.0",
    });
    expect(entry?.digest).toBe(digest);
  });

  test("reports the same bytes offered twice as unchanged and leaves the documents identical", async () => {
    await writeOffer(root, [offer()], "2026-01-02T00:00:00Z", alone);
    const before = {
      versions: await readFile(join(root, "artifacts/house/skill/lint/versions.json"), "utf8"),
      index: await readFile(join(root, "index.json"), "utf8"),
    };

    const again = await writeOffer(root, [offer()], "2026-06-06T00:00:00Z", alone);

    expect(again.unchanged).toBe(true);
    expect(await readFile(join(root, "artifacts/house/skill/lint/versions.json"), "utf8")).toBe(
      before.versions,
    );
    expect(await readFile(join(root, "index.json"), "utf8")).toBe(before.index);
  });

  test("adds a second version beside the first and moves latest to it", async () => {
    await writeOffer(root, [offer()], "2026-01-02T00:00:00Z", alone);
    await writeOffer(
      root,
      [
        offer({
          version: "1.1.0",
          files: [{ path: "SKILL.md", content: body("Two.\n"), executable: false }],
        }),
      ],
      "2026-01-03T00:00:00Z",
      alone,
    );

    const versions = await readVersions(read(root), "house", "skill", "lint");
    expect(versions.versions.map((v) => v.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(versions.latest).toBe("1.1.0");
    expect(
      await readFile(join(root, "artifacts/house/skill/lint/1.0.0/SKILL.md"), "utf8"),
    ).toContain("One.");
  });

  test("leaves latest, in both documents, on the highest version when a lower one is offered", async () => {
    await writeOffer(root, [offer()], "2026-01-02T00:00:00Z", alone);
    await writeOffer(
      root,
      [
        offer({
          version: "0.9.1",
          files: [{ path: "SKILL.md", content: body("Backport.\n"), executable: false }],
        }),
      ],
      "2026-01-03T00:00:00Z",
      alone,
    );

    expect((await readVersions(read(root), "house", "skill", "lint")).latest).toBe("1.0.0");
    const [entry] = await readIndex(read(root));
    expect(entry).toMatchObject({ latest: "1.0.0", digest: await pinned("1.0.0") });
  });

  test("never rewrites a released version, nor writes another in its place", async () => {
    const first = offer({
      files: [
        { path: "SKILL.md", content: body("One.\n"), executable: false },
        { path: "extra.md", content: body("kept\n"), executable: false },
      ],
    });
    await writeOffer(root, [first], "2026-01-02T00:00:00Z", alone);
    const fresh = offer({ name: "fresh" });

    await expect(
      writeOffer(root, [fresh, offer()], "2026-01-03T00:00:00Z", alone),
    ).rejects.toMatchObject({
      failure: "conflict",
      message: "house/skill/lint@1.0.0 is already published with other content.",
    });

    const versions = await readVersions(read(root), "house", "skill", "lint");
    expect(versions.versions.map((each) => each.version)).toEqual(["1.0.0"]);
    expect(await readFile(join(root, "artifacts/house/skill/lint/1.0.0/extra.md"), "utf8")).toBe(
      "kept\n",
    );
    // Refused before anything was written, so the change beside it is not there either.
    await expect(
      readFile(join(root, "artifacts/house/skill/fresh/versions.json")),
    ).rejects.toThrow();
    expect((await writeOffer(root, [first], "2026-01-04T00:00:00Z", alone)).unchanged).toBe(true);
  });

  test("refuses a version versions.json lists with other content, though its folder is gone", async () => {
    await writeOffer(root, [offer()], "2026-01-02T00:00:00Z", alone);
    await rm(join(root, "artifacts/house/skill/lint/1.0.0"), { recursive: true });
    const other = offer({
      files: [{ path: "SKILL.md", content: body("Other.\n"), executable: false }],
    });
    await expect(writeOffer(root, [other], "2026-01-03T00:00:00Z", alone)).rejects.toMatchObject({
      failure: "conflict",
    });
  });

  test("refuses anything that cannot be a path segment", async () => {
    await expect(writeOffer(root, [offer({ namespace: "../escape" })], "x", alone)).rejects.toThrow(
      SpecError,
    );
    await expect(
      writeOffer(root, [offer({ version: "not a version" })], "x", alone),
    ).rejects.toThrow(SpecError);
    await expect(writeOffer(root, [offer({ namespace: undefined })], "x", alone)).rejects.toThrow(
      /no namespace or version/,
    );
  });

  test("refuses the whole offer, writing nothing, when one change has no place", async () => {
    const placeless = offer({ name: "fresh", namespace: undefined });
    await expect(writeOffer(root, [offer(), placeless], "x", alone)).rejects.toThrow(
      /fresh has no namespace or version/,
    );
    await expect(
      readFile(join(root, "artifacts/house/skill/lint/versions.json")),
    ).rejects.toThrow();
    await expect(readFile(join(root, "index.json"))).rejects.toThrow();
  });

  test("with partial, returns the placeless change by position and writes the rest", async () => {
    const placeless = offer({ name: "fresh", namespace: undefined });
    const written = await writeOffer(root, [placeless, offer()], "x", alone, true);
    expect(written.refused).toHaveLength(1);
    expect(written.refused[0]).toMatchObject({
      index: 0,
      error: { failure: "invalid", message: expect.stringMatching(/fresh has no namespace/) },
    });
    expect((await readVersions(read(root), "house", "skill", "lint")).latest).toBe("1.0.0");
    expect((await readIndex(read(root))).map((each) => each.name)).toEqual(["lint"]);
  });

  test("refuses a segment Windows reserves for a device", async () => {
    for (const change of [{ name: "con" }, { namespace: "aux" }, { name: "lpt9" }]) {
      await expect(writeOffer(root, [offer(change)], "x", alone)).rejects.toThrow(
        /is a device name on Windows/,
      );
    }
  });
});

describe("the envelope a publish writes", () => {
  test("describes each file as every file spec writer does", async () => {
    await writeOffer(root, [offer()], "2026-01-02T00:00:00Z", alone);
    const written = JSON.parse(
      await readFile(join(root, "artifacts/house/skill/lint/1.0.0/artifact.json"), "utf8"),
    );
    const [file] = offer().files;
    if (file === undefined) throw new Error("the offer has no file");
    expect(written.files).toEqual([
      describeFile(file.path, sha256(file.content), file.content.byteLength),
    ]);
    expect(written.files[0]).toMatchObject({ media_type: "text/markdown" });
  });

  test("carries the version's relationships, and an edge alone makes another version", async () => {
    const edge = { rel_type: "depends_on", to: "house/skill/style@1.2.0" };
    await writeOffer(root, [offer({ relationships: [edge] })], "2026-01-02T00:00:00Z", alone);
    const envelope = (version: string) =>
      readFile(join(root, `artifacts/house/skill/lint/${version}/artifact.json`), "utf8").then(
        (text) => JSON.parse(text) as { relationships?: unknown },
      );
    expect((await envelope("1.0.0")).relationships).toEqual([edge]);
    const versions = await readVersions(read(root), "house", "skill", "lint");
    expect(versions.versions[0]?.digest).toBe(await pinned("1.0.0"));

    const moved = { ...edge, to: "house/skill/style@1.3.0" };
    await expect(
      writeOffer(root, [offer({ relationships: [moved] })], "2026-01-03T00:00:00Z", alone),
    ).rejects.toMatchObject({ failure: "conflict" });
    const written = await writeOffer(
      root,
      [offer({ version: "1.0.1", relationships: [moved] })],
      "2026-01-03T00:00:00Z",
      alone,
    );

    expect(written.unchanged).toBe(false);
    expect((await readVersions(read(root), "house", "skill", "lint")).latest).toBe("1.0.1");
    expect((await envelope("1.0.0")).relationships).toEqual([edge]);
    expect((await envelope("1.0.1")).relationships).toEqual([moved]);
  });
});
