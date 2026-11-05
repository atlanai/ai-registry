import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { fileTest as test } from "#test/kit/fixtures.ts";
import { skillBody } from "#test/kit/spec-root.ts";

let registryRoot: string;
/** Where the artifacts being published are written, outside any target folder. */
let work: string;

const versions = async (namespace: string, kind: string, name: string) =>
  readFile(join(registryRoot, "artifacts", namespace, kind, name, "versions.json"), "utf8");

test.beforeAll(async ({ tmp }) => {
  registryRoot = join(tmp, "registry");
  work = join(tmp, "work");
  await Promise.all([
    mkdir(join(work, "skills", "lint"), { recursive: true }),
    mkdir(join(work, "skills", "deploy"), { recursive: true }),
    mkdir(join(work, "agents"), { recursive: true }),
  ]);
  await writeFile(
    join(work, "skills", "lint", "SKILL.md"),
    skillBody("lint", "lint", "Run the linter.\n"),
  );
  await writeFile(
    join(work, "skills", "deploy", "SKILL.md"),
    skillBody("deploy", "deploy", "Tag and publish.\n"),
  );
  await writeFile(
    join(work, "agents", "triage.md"),
    "---\nname: triage\ndescription: Label and route.\n---\nLabel and route.\n",
  );
});

describe("creating a registry and publishing into it", () => {
  test("creates an empty registry, and declares it only when added", async ({ aireg }) => {
    const made = await aireg(["registry", "init", registryRoot, "--name", "team", "-y"], {
      cwd: work,
    });
    expect(made.code, made.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(registryRoot, "index.json"), "utf8")).entries).toEqual(
      [],
    );
    const again = await aireg(["registry", "init", registryRoot, "-y"], { cwd: work });
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("Nothing was changed");
    expect((await aireg(["registry", "add", registryRoot], { cwd: work })).code).toBe(0);
  });

  test("publishes what a glob matches, each at 0.1.0", async ({ aireg }) => {
    const sent = await aireg(["publish", "skills/*", "--to", "team/platform", "--yes"], {
      cwd: work,
    });
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stdout).toMatch(/add\s+platform\/skill\/deploy\s+0\.1\.0/);
    expect(sent.stdout).toMatch(/add\s+platform\/skill\/lint\s+0\.1\.0/);
  });

  test("bumps a patch by default, and as asked otherwise", async ({ aireg }) => {
    await appendFile(join(work, "skills", "lint", "SKILL.md"), "Also typecheck.\n");
    expect(
      (await aireg(["publish", "skills/lint", "--to", "team/platform", "--yes"], { cwd: work }))
        .code,
    ).toBe(0);
    await appendFile(join(work, "skills", "lint", "SKILL.md"), "And format.\n");
    const minor = ["publish", "skills/lint", "--to", "team/platform", "--bump", "minor", "--yes"];
    expect((await aireg(minor, { cwd: work })).code).toBe(0);
    expect(await versions("platform", "skill", "lint")).toMatch(/0\.2\.0[\s\S]*0\.1\.1/);
  });

  test("takes an exact version, and never rewrites one that is published", async ({ aireg }) => {
    await appendFile(join(work, "skills", "lint", "SKILL.md"), "Strictly.\n");
    const exact = ["publish", "skills/lint", "--to", "team/platform/skill/lint@1.0.0", "--yes"];
    expect((await aireg(exact, { cwd: work })).code).toBe(0);
    const taken = await aireg(exact, { cwd: work });
    expect(taken.code).not.toBe(0);
    expect(taken.stderr).toMatch(/already published/);
  });

  test("asks for a version rather than guessing one after a version that is not SemVer", async ({
    aireg,
  }) => {
    await mkdir(join(work, "skills", "notify"), { recursive: true });
    await writeFile(
      join(work, "skills", "notify", "SKILL.md"),
      skillBody("notify", "notify", "Post a note.\n"),
    );
    const first = await aireg(
      ["publish", "skills/notify", "--to", "team/platform/skill/notify@1", "--yes"],
      { cwd: work },
    );
    expect(first.code, first.stderr).toBe(0);
    await appendFile(join(work, "skills", "notify", "SKILL.md"), "Then announce it.\n");
    const next = await aireg(["publish", "skills/notify", "--to", "team/platform", "--yes"], {
      cwd: work,
    });
    expect(next.code).toBe(2);
    expect(next.stderr).toMatch(/1, is not a SemVer version/);
    expect(await versions("platform", "skill", "notify")).not.toMatch(/"0\.1\.0"/);
  });

  test("publishes past an archived latest, even with the same files", async ({ aireg }) => {
    const path = join(work, "archive", "retire");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), skillBody("retire", "retire", "Retire it.\n"));
    const send = () =>
      aireg(["publish", "archive/retire", "--to", "team/platform", "--yes"], { cwd: work });
    expect((await send()).code).toBe(0);
    const at = join(registryRoot, "artifacts", "platform", "skill", "retire", "versions.json");
    const document = JSON.parse(await readFile(at, "utf8"));
    for (const row of document.versions) row.status = "archived";
    await writeFile(at, JSON.stringify(document, null, 2));
    expect((await aireg(["registry", "index"], { cwd: registryRoot })).code).toBe(0);

    const sent = await send();
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stdout).toMatch(/update\s+platform\/skill\/retire\s+0\.1\.0 → 0\.1\.1/);
  });

  test("writes each of three publishes at once at the version it reports, or refuses it", async ({
    aireg,
  }) => {
    const racers = ["a", "b", "c"];
    for (const racer of racers) {
      await mkdir(join(work, "race", racer, "racer"), { recursive: true });
      await writeFile(
        join(work, "race", racer, "racer", "SKILL.md"),
        skillBody("racer", "racer", `Run ${racer}.\n`),
      );
    }
    const sent = await Promise.all(
      racers.map((racer) =>
        aireg(["publish", `race/${racer}/racer`, "--to", "team/platform", "--yes"], { cwd: work }),
      ),
    );

    const reported: string[] = [];
    for (const [at, run] of sent.entries()) {
      if (run.code !== 0) {
        expect(run.stderr).toMatch(
          /platform\/skill\/racer@[\d.]+ is already published with other content\./,
        );
        continue;
      }
      const version = /racer {2}(?:[\d.]+ → )?([\d.]+)/.exec(run.stdout)?.[1] ?? "";
      reported.push(version);
      expect(
        await readFile(
          join(registryRoot, "artifacts", "platform", "skill", "racer", version, "SKILL.md"),
          "utf8",
        ),
      ).toContain(`Run ${racers[at]}.`);
    }
    expect(reported.length).toBeGreaterThan(0);
    const listed = JSON.parse(await versions("platform", "skill", "racer")).versions.map(
      (row: { version: string }) => row.version,
    );
    expect([...listed].sort()).toEqual([...reported].sort());
    expect((await aireg(["registry", "validate"], { cwd: registryRoot })).code).toBe(0);
  });

  test("publishes an agent from one file, and says what it sent under --json", async ({
    aireg,
  }) => {
    const sent = await aireg(
      ["publish", "agents/triage.md", "--to", "team/data", "--yes", "--json"],
      { cwd: work },
    );
    expect(sent.code, sent.stderr).toBe(0);
    // A first version adds every file it sends, so `filesChanged` lists them all as added.
    expect(JSON.parse(sent.stdout).data).toEqual({
      dryRun: false,
      target: { registry: "team", namespace: "data" },
      artifacts: [
        {
          name: "triage",
          kind: "agent",
          registry: "team",
          namespace: "data",
          from: null,
          version: "0.1.0",
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          belowLatest: false,
          published: true,
          dependsOn: [],
          filesChanged: { added: ["AGENT.md"], changed: [], removed: [] },
        },
      ],
      skipped: [],
    });
    expect(await versions("data", "agent", "triage")).toContain("0.1.0");
  });

  test("suggests the publish an agent created outside a registry takes, and it works", async ({
    aireg,
  }) => {
    const drafts = join(work, "drafts");
    await mkdir(drafts, { recursive: true });
    const made = await aireg(["agent", "new", "planner", "--set", "description=Plan it."], {
      cwd: drafts,
    });
    expect(made.code, made.stderr).toBe(0);
    const next = /next\s+(aireg publish \S+) --to/.exec(made.stdout)?.[1];
    expect(next).toBe("aireg publish planner/AGENT.md");
    const sent = await aireg(["publish", "planner/AGENT.md", "--to", "team/data", "--yes"], {
      cwd: drafts,
    });
    expect(sent.code, sent.stderr).toBe(0);
    const unnamed = await aireg(["agent", "bump"], { cwd: drafts });
    expect(unnamed.stderr).toContain("`aireg agent bump` needs a name.");
  });

  test("sends only what changed since a revision", async ({ aireg, git }) => {
    await git.init(work);
    await git.commit(work, "base");
    await appendFile(join(work, "skills", "lint", "SKILL.md"), "Changed since.\n");

    const since = ["publish", "skills/*", "--to", "team/platform", "--changed-since", "HEAD"];
    const sent = await aireg([...since, "--yes"], { cwd: work });
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stdout).toMatch(/update\s+platform\/skill\/lint/);
    expect(sent.stdout).not.toMatch(/deploy/);
  });
});
