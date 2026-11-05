import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { SourceContext } from "#adapter/index.ts";
import { test } from "#test/kit/fixtures.ts";
import { sourceContext } from "#test/kit/source-context.ts";
import { skillBody, writeSpecRoot } from "#test/kit/spec-root.ts";
import { connect } from "./connect.ts";

const snapshotRoot = vi.hoisted(() => ({ root: "" }));
vi.mock("./resolve.ts", () => ({
  resolveRef: async () => ({ commit: "a".repeat(40) }),
}));
vi.mock("./snapshot.ts", () => ({
  snapshot: async () => ({ root: snapshotRoot.root, commit: "a".repeat(40) }),
  holdSnapshot: () => () => {},
}));

let home: string;
let root: string;
const body = skillBody("sample");
function context(folder = ""): SourceContext {
  return sourceContext({
    registry: "demo",
    location: "https://example.test/demo.git",
    config: folder === "" ? {} : { path: folder },
    key: "sha256:synthetic",
  });
}

test.beforeEach(async ({ tmp }) => {
  home = tmp;
  root = join(home, "registry");
  await writeSpecRoot(root, [
    {
      namespace: "demo",
      kind: "skill",
      name: "sample",
      versions: [{ version: "1.0.0", files: { "SKILL.md": body } }],
    },
  ]);
  snapshotRoot.root = root;
});
test("reports a file spec refusal as its own invalid failure", async () => {
  const index = join(root, "index.json");
  await rename(index, join(home, "index.json"));
  await symlink(join(home, "index.json"), index);
  const handle = await connect(context());
  await expect(handle.resolve([])).rejects.toMatchObject({ adapter: "git", failure: "invalid" });
});
test("reports an artifact it did not list as not found", async () => {
  const handle = await connect(context());
  const artifact = (await handle.resolve([])).artifacts[0]!;
  await expect(
    handle.fetch({ ...artifact, id: "artifacts/demo/skill/other/1.0.0" }, artifact.files[0]!),
  ).rejects.toMatchObject({ adapter: "git", failure: "not_found" });
});
test("refuses a Git registry subfolder that is a symlink", async () => {
  const clone = join(home, "clone");
  await mkdir(clone);
  await symlink(root, join(clone, "registry"));
  snapshotRoot.root = clone;
  const handle = await connect(context("registry"));
  await expect(handle.resolve([])).rejects.toMatchObject({ adapter: "git", failure: "invalid" });
});
test("reads a Git registry in an ordinary subfolder", async () => {
  snapshotRoot.root = home;
  await writeFile(join(home, "unrelated"), "");
  const handle = await connect(context("registry"));
  const artifact = (await handle.resolve([])).artifacts[0]!;
  expect(Buffer.from(await handle.fetch(artifact, artifact.files[0]!)).toString()).toBe(body);
});
