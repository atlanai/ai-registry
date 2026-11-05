import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { skillBody, writeSpecRoot } from "#test/kit/spec-root.ts";
import { contentDigest } from "../spec/canonical.ts";
import type { Envelope } from "../spec/types.ts";
import { SpecError } from "./documents.ts";
import { openFolderRegistry } from "./folder.ts";

let home: string;
let root: string;
const id = "artifacts/demo/skill/sample/1.0.0";
const body = skillBody("sample");

async function locator(url: string): Promise<void> {
  const file = join(root, id, "artifact.json");
  const envelope = JSON.parse(await readFile(file, "utf8")) as Envelope;
  envelope.files[0] = { ...envelope.files[0]!, urls: [url] };
  const digest = contentDigest(envelope);
  envelope.metadata.digest = digest;
  await writeFile(file, JSON.stringify(envelope));
  const versionsFile = join(root, id, "..", "versions.json");
  const versions = JSON.parse(await readFile(versionsFile, "utf8"));
  versions.versions[0].digest = digest;
  await writeFile(versionsFile, JSON.stringify(versions));
}

const refused = expect.objectContaining({ name: "SpecError", missing: false });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "aireg-source-containment-"));
  root = join(home, "registry");
  await writeSpecRoot(root, [
    {
      namespace: "demo",
      kind: "skill",
      name: "sample",
      versions: [{ version: "1.0.0", files: { "SKILL.md": body } }],
    },
  ]);
  await writeFile(join(home, "sentinel"), body);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

// Both built-in adapters read through this, so one table holds them to the same rules.
describe("file spec containment", () => {
  test("refuses an envelope locator that climbs out of the source", async () => {
    await locator("../../../../../../sentinel");
    const files = openFolderRegistry();
    const artifact = (await files.resolve(root, [])).artifacts[0]!;
    await expect(files.fetch(artifact, artifact.files[0]!)).rejects.toEqual(refused);
  });
  test("refuses a symlinked metadata file", async () => {
    const index = join(root, "index.json");
    await rename(index, join(home, "index.json"));
    await symlink(join(home, "index.json"), index);
    await expect(openFolderRegistry().resolve(root, [])).rejects.toEqual(refused);
  });
  test("refuses a symlinked content file", async () => {
    const files = openFolderRegistry();
    const artifact = (await files.resolve(root, [])).artifacts[0]!;
    const file = join(root, id, "SKILL.md");
    await rm(file);
    await symlink(join(home, "sentinel"), file);
    await expect(files.fetch(artifact, artifact.files[0]!)).rejects.toEqual(refused);
  });
  test("refuses a redirected version directory in the in-place shortcut", async () => {
    const files = openFolderRegistry();
    const artifact = (await files.resolve(root, [])).artifacts[0]!;
    await rename(join(root, id), join(home, "version"));
    await symlink(join(home, "version"), join(root, id));
    await expect(files.localRoot(artifact)).rejects.toEqual(refused);
  });
  test.each(["/absolute", "C:/absolute", "..\\sentinel", "safe/../sentinel", "bad\u0000path"])(
    "refuses unsafe locator %s",
    async (path) => {
      const files = openFolderRegistry();
      const artifact = (await files.resolve(root, [])).artifacts[0]!;
      await expect(
        files.fetch(artifact, { ...artifact.files[0]!, locator: path }),
      ).rejects.toBeInstanceOf(SpecError);
    },
  );
  test("refuses a replaced registry root", async () => {
    await rename(root, join(home, "redirected-root"));
    await symlink(join(home, "redirected-root"), root);
    await expect(openFolderRegistry().resolve(root, [])).rejects.toEqual(refused);
  });
  test("reads nothing it did not list, and nothing after it forgets", async () => {
    const files = openFolderRegistry();
    const artifact = (await files.resolve(root, [])).artifacts[0]!;
    files.forget();
    await expect(files.fetch(artifact, artifact.files[0]!)).rejects.toMatchObject({
      missing: true,
      artifact: id,
    });
  });
  test("reads valid regular content", async () => {
    const files = openFolderRegistry();
    const artifact = (await files.resolve(root, [])).artifacts[0]!;
    expect(Buffer.from(await files.fetch(artifact, artifact.files[0]!)).toString()).toBe(body);
    expect(await files.localRoot(artifact)).toBe(join(root, id));
  });
});

describe("an immutable folder", () => {
  test("is read once per listing, and still reads files afterwards", async () => {
    const first = openFolderRegistry({ immutable: true });
    await first.resolve(root, []);
    await rm(join(root, "index.json"));
    const again = openFolderRegistry({ immutable: true });
    const artifact = (await again.resolve(root, [])).artifacts[0]!;
    expect(Buffer.from(await again.fetch(artifact, artifact.files[0]!)).toString()).toBe(body);
  });
});
