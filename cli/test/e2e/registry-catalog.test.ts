import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";

let root: string;

test.beforeAll(({ tmp }) => {
  root = tmp;
});

describe("keeping the catalog honest", () => {
  const catalog = () => join(root, "catalog");
  const demo = (...rest: string[]) => join(catalog(), "artifacts", "eng", "skill", "demo", ...rest);
  const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
  const edit = async (path: string, change: (document: Record<string, unknown>) => void) => {
    const document = await json(path);
    change(document);
    await writeFile(path, `${JSON.stringify(document, undefined, 2)}\n`);
  };
  const validate = (aireg: Aireg) => aireg(["registry", "validate"], { cwd: catalog() });

  test.beforeAll(async ({ aireg }) => {
    const init = ["registry", "init", catalog(), "--name", "catalog", "--namespace", "eng", "-y"];
    expect((await aireg(init)).code).toBe(0);
    const eng = join(catalog(), "artifacts", "eng");
    expect((await aireg(["skill", "new", "demo"], { cwd: eng })).code).toBe(0);
    await writeFile(demo("0.1.0", "SKILL.md"), "---\nname: demo\ndescription: Demo.\n---\n");
    expect((await aireg(["skill", "bump", "demo", "minor"], { cwd: eng })).code).toBe(0);
    expect((await aireg(["registry", "index"], { cwd: catalog() })).code).toBe(0);
  });

  test("writes the kind's own document as the envelope's spec", async () => {
    const envelope = await json(demo("0.1.0", "artifact.json"));
    expect(envelope.spec).toEqual({ name: "demo", description: "Demo." });
  });

  test("indexes the agent card `agent new --file agent-card.json` writes", async ({ aireg }) => {
    const eng = join(catalog(), "artifacts", "eng");
    const card = [
      ...["agent", "new", "carded", "--file", "agent-card.json"],
      ...["--set", "description=Answers from a card.", "-y"],
    ];
    expect((await aireg(card, { cwd: eng })).code).toBe(0);
    const indexed = await aireg(["registry", "index"], { cwd: catalog() });
    expect(indexed.code, indexed.stderr).toBe(0);
    const envelope = await json(join(eng, "agent", "carded", "0.1.0", "artifact.json"));
    expect(envelope.spec).toMatchObject({
      name: "carded",
      description: "Answers from a card.",
      card: { name: "carded" },
    });
    expect(envelope.spec).not.toHaveProperty("runtime");
  });

  test("refuses a base that git would read as an option", async ({ aireg }) => {
    const planted = join(root, "planted.txt");
    const ran = await aireg(["registry", "validate", `--base=--output=${planted}`], {
      cwd: catalog(),
    });
    expect(ran.code).not.toBe(0);
    expect(ran.stderr).toMatch(/--base takes a git ref/);
    expect(existsSync(planted)).toBe(false);
  });

  test("moves latest off a yanked version when indexing, and validate flags it until then", async ({
    aireg,
  }) => {
    await edit(demo("versions.json"), (document) => {
      for (const row of document.versions as { version: string; yanked: boolean }[]) {
        if (row.version === "0.2.0") row.yanked = true;
      }
    });
    const flagged = await validate(aireg);
    expect(flagged.code).toBe(1);
    expect(flagged.stdout).toMatch(/latest is 0\.2\.0, but the newest active release is 0\.1\.0/);
    expect((await aireg(["registry", "index"], { cwd: catalog() })).code).toBe(0);
    expect((await json(demo("versions.json"))).latest).toBe("0.1.0");
    expect((await json(join(catalog(), "index.json"))).entries[0].latest).toBe("0.1.0");
    expect((await validate(aireg)).code).toBe(0);
  });

  test("reports an index.json that disagrees with versions.json", async ({ aireg }) => {
    const index = join(catalog(), "index.json");
    const before = await readFile(index, "utf8");
    await edit(index, (document) => {
      for (const row of document.entries as { digest: string }[])
        row.digest = `sha256:${"d".repeat(64)}`;
    });
    const digest = await validate(aireg);
    expect(digest.code).toBe(1);
    expect(digest.stdout).toMatch(
      /eng\/skill\/demo digest is sha256:d+, but versions\.json says sha256:/,
    );
    await writeFile(index, before);

    await edit(index, (document) => {
      for (const row of document.entries as { latest: string }[]) row.latest = "0.0.1";
    });
    const latest = await validate(aireg);
    expect(latest.code).toBe(1);
    expect(latest.stdout).toMatch(
      /eng\/skill\/demo latest is 0\.0\.1, but versions\.json says 0\.1\.0/,
    );
    await writeFile(index, before);
  });

  test("reports a versions.json filed under another name", async ({ aireg }) => {
    const versions = demo("versions.json");
    const before = await readFile(versions, "utf8");
    await edit(versions, (document) => {
      document.namespace = "other";
    });
    const moved = await validate(aireg);
    expect(moved.code).toBe(1);
    expect(moved.stdout).toMatch(/namespace is other, but its folder says eng/);
    await writeFile(versions, before);
    expect((await validate(aireg)).code).toBe(0);
  });

  // 0.2.0 was yanked above: a yanked release still keeps its folder.
  test("reports a listed version whose folder is gone, and will not index it", async ({
    aireg,
  }) => {
    const away = join(root, "demo-0.2.0");
    await rename(demo("0.2.0"), away);
    const missing = await validate(aireg);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toMatch(/demo\/0\.2\.0\s+is missing, but versions\.json lists 0\.2\.0/);
    expect(missing.stdout).toMatch(
      /fix: restore artifacts\/eng\/skill\/demo\/0\.2\.0\/, or if 0\.2\.0 was never released, remove it from versions\.json/,
    );
    expect((await aireg(["registry", "index"], { cwd: catalog() })).code).toBe(1);
    await rename(away, demo("0.2.0"));
    expect((await validate(aireg)).code).toBe(0);
  });

  test("refuses, against its base, a change that deletes a released artifact", async ({
    aireg,
    git,
  }) => {
    await git(catalog(), "init", "-q", "-b", "main");
    await git.commit(catalog(), "release");
    await git(catalog(), "checkout", "-q", "-b", "drop");
    await git(catalog(), "rm", "-rq", "artifacts/eng/skill/demo");
    // Indexing drops the row, so only the base can tell a release went missing.
    expect((await aireg(["registry", "index"], { cwd: catalog() })).code).toBe(0);
    const dropped = await aireg(["registry", "validate", "--base", "main"], { cwd: catalog() });
    expect(dropped.code).toBe(1);
    expect(dropped.stdout).toMatch(/is missing, but 0\.1\.0 was released/);
    expect(dropped.stdout).toMatch(
      /fix: git checkout main -- artifacts\/eng\/skill\/demo; to withdraw a release, set "yanked": true in its versions\.json instead/,
    );
  });
});

describe("a change that edits a released version", () => {
  test("names the commands that move the edit into a new version, and they work as printed", async ({
    aireg,
    git,
  }) => {
    const reg = join(root, "edited");
    const init = ["registry", "init", reg, "--name", "edited", "--namespace", "eng", "-y"];
    expect((await aireg(init)).code).toBe(0);
    const eng = join(reg, "artifacts", "eng");
    const skill = (version: string) => join(eng, "skill", "lint", version, "SKILL.md");
    expect((await aireg(["skill", "new", "lint"], { cwd: eng })).code).toBe(0);
    await writeFile(skill("0.1.0"), "---\nname: lint\ndescription: Lint.\n---\n");
    expect((await aireg(["registry", "index"], { cwd: reg })).code).toBe(0);
    await git(reg, "init", "-q", "-b", "main");
    await git.commit(reg, "release");
    await git(reg, "checkout", "-q", "-b", "stricter");
    await writeFile(skill("0.1.0"), "---\nname: lint\ndescription: Lint, stricter.\n---\n");
    await git.commit(reg, "edit the release");

    const checked = await aireg(["registry", "validate", "--base", "main"], { cwd: reg });
    expect(checked.code).toBe(1);
    expect(checked.stdout).toContain("changed since 0.1.0 was released");
    const fix =
      "aireg skill bump lint --namespace eng && git checkout main -- artifacts/eng/skill/lint/0.1.0 && aireg registry index";
    expect(checked.stdout).toContain(`fix: ${fix}`);
    for (const command of fix.split(" && ")) {
      const [program, ...args] = command.split(" ");
      if (program === "git") {
        await git(reg, ...args);
        continue;
      }
      expect((await aireg(args, { cwd: reg })).code).toBe(0);
    }

    const fixed = await aireg(["registry", "validate", "--base", "main"], { cwd: reg });
    expect(fixed.code, fixed.stdout).toBe(0);
    expect(await readFile(skill("0.1.1"), "utf8")).toContain("stricter");
    expect(await readFile(skill("0.1.0"), "utf8")).not.toContain("stricter");
  });
});
