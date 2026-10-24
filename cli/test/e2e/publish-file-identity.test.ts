import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { type Aireg, type Git, test } from "#test/kit/fixtures.ts";
import { writeManifestIn } from "#test/kit/scope.ts";

function manifest(mapped = false, fixed = false, destination = "old.md"): string {
  return `exports:
  - path: agents/reviewer
${mapped ? `    include: [{ from: one.md, as: ${destination} }]\n` : ""}${fixed ? "    version: 0.1.0\n" : ""}publish:
  to: ./registry/engineering
`;
}

async function fixture(aireg: Aireg, git: Git, tmp: string, mapped = false, fixed = false) {
  const maker = join(tmp, "maker");
  const agent = join(maker, "agents", "reviewer");
  await git.init(maker);
  await mkdir(agent, { recursive: true });
  await writeFile(
    join(agent, "AGENT.md"),
    "---\nname: reviewer\ndescription: Reviews code.\n---\n",
  );
  await writeFile(join(agent, "one.md"), "First.\n");
  await writeFile(join(agent, "two.md"), "Second.\n");
  await writeManifestIn(maker, manifest(mapped, fixed));
  await git.commit(maker);
  const run = (args: string[]) => aireg(args, { cwd: maker });
  const made = await run(["registry", "init", "registry", "--name", "fixture", "-y"]);
  expect(made.code, made.stderr).toBe(0);
  const first = await run(["publish", "-y"]);
  expect(first.code, first.stderr).toBe(0);
  const stored = (version: string, path: string) =>
    readFile(join(maker, "registry/artifacts/engineering/agent/reviewer", version, path), "utf8");
  return { maker, agent, run, stored };
}

test("publishes renamed files and shows the removed and added paths", async ({
  aireg,
  git,
  tmp,
}) => {
  const { maker, agent, run, stored } = await fixture(aireg, git, tmp);
  await rename(join(agent, "one.md"), join(agent, "renamed.md"));
  await git.commit(maker);
  const dry = await run(["publish", "--dry-run", "--json"]);
  expect(dry.code, dry.stderr).toBe(0);
  expect(JSON.parse(dry.stdout).data.artifacts[0]).toMatchObject({
    from: "0.1.0",
    version: "0.1.1",
    filesChanged: { added: ["renamed.md"], changed: [], removed: ["one.md"] },
  });
  const sent = await run(["publish", "-y"]);
  expect(sent.code, sent.stderr).toBe(0);
  expect(await stored("0.1.1", "renamed.md")).toBe("First.\n");
  await expect(stored("0.1.1", "one.md")).rejects.toMatchObject({ code: "ENOENT" });
  expect(await stored("0.1.0", "one.md")).toBe("First.\n");
  expect((await run(["publish", "--dry-run"])).stdout).toContain("Nothing new to publish.");
});

test("publishes an include destination edit without changing its source bytes", async ({
  aireg,
  git,
  tmp,
}) => {
  const { maker, run, stored } = await fixture(aireg, git, tmp, true);
  await writeManifestIn(maker, manifest(true, false, "new.md"));
  await git.commit(maker);
  const sent = await run(["publish", "-y", "--json"]);
  expect(sent.code, sent.stderr).toBe(0);
  expect(JSON.parse(sent.stdout).data.artifacts[0]).toMatchObject({
    version: "0.1.1",
    published: true,
    filesChanged: { added: ["new.md"], changed: [], removed: ["old.md"] },
  });
  expect(await stored("0.1.1", "new.md")).toBe("First.\n");
  await expect(stored("0.1.1", "old.md")).rejects.toMatchObject({ code: "ENOENT" });
});

test("publishes swapped file contents with the same digest set", async ({ aireg, git, tmp }) => {
  const { maker, agent, run, stored } = await fixture(aireg, git, tmp);
  await writeFile(join(agent, "one.md"), "Second.\n");
  await writeFile(join(agent, "two.md"), "First.\n");
  await git.commit(maker);
  const sent = await run(["publish", "-y", "--json"]);
  expect(sent.code, sent.stderr).toBe(0);
  expect(JSON.parse(sent.stdout).data.artifacts[0]).toMatchObject({
    version: "0.1.1",
    published: true,
    filesChanged: { added: [], changed: ["one.md", "two.md"], removed: [] },
  });
  expect(await stored("0.1.1", "one.md")).toBe("Second.\n");
  expect(await stored("0.1.1", "two.md")).toBe("First.\n");
});

test("refuses a remap at an already published fixed version", async ({ aireg, git, tmp }) => {
  const { maker, run, stored } = await fixture(aireg, git, tmp, true, true);
  await writeManifestIn(maker, manifest(true, true, "new.md"));
  await git.commit(maker);
  const sent = await run(["publish", "-y"]);
  expect(sent.code).not.toBe(0);
  expect(sent.stderr).toContain("already published");
  expect(await stored("0.1.0", "old.md")).toBe("First.\n");
  await expect(stored("0.1.0", "new.md")).rejects.toMatchObject({ code: "ENOENT" });
});
