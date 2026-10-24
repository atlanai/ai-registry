import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect } from "vitest";
import { gitRegistry, registry } from "#test/kit/builders/registry.ts";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";
import { exec } from "#test/kit/run.ts";
import { writeManifestIn } from "#test/kit/scope.ts";
import { skillBody } from "#test/kit/spec-root.ts";

let root: string;
let registryRoot: string;
/** Where the artifacts being published are written, outside any harness folder. */
let work: string;

const versions = async (namespace: string, kind: string, name: string) =>
  readFile(join(registryRoot, "artifacts", namespace, kind, name, "versions.json"), "utf8");

test.beforeAll(async ({ tmp, project, git }) => {
  root = tmp;
  registryRoot = join(root, "registry");
  work = join(root, "work");
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
  await git.init(project);
}, 60_000);

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

  test("says nothing is new when the files are already published", async ({ aireg }) => {
    const again = await aireg(["publish", "skills/*", "--to", "team/platform", "--yes"], {
      cwd: work,
    });
    expect(again.stdout).toMatch(/Nothing new to publish/);
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

  test("counts the next version past a yanked one, though latest moved below it", async ({
    aireg,
  }) => {
    const path = join(work, "yank", "format");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), skillBody("format", "format", "Format it.\n"));
    const send = () =>
      aireg(["publish", "yank/format", "--to", "team/platform", "--yes"], { cwd: work });
    expect((await send()).code).toBe(0);
    await appendFile(join(path, "SKILL.md"), "Then sort imports.\n");
    expect((await send()).code).toBe(0);
    const at = join(registryRoot, "artifacts", "platform", "skill", "format", "versions.json");
    const document = JSON.parse(await readFile(at, "utf8"));
    for (const row of document.versions) if (row.version === "0.1.1") row.yanked = true;
    await writeFile(at, JSON.stringify(document, null, 2));
    expect((await aireg(["registry", "index"], { cwd: registryRoot })).code).toBe(0);
    expect(JSON.parse(await readFile(at, "utf8")).latest).toBe("0.1.0");

    await appendFile(join(path, "SKILL.md"), "And wrap long lines.\n");
    const sent = await send();
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stdout).toMatch(/update\s+platform\/skill\/format\s+0\.1\.0 → 0\.1\.2/);
    expect(
      await readFile(
        join(registryRoot, "artifacts", "platform", "skill", "format", "0.1.2", "SKILL.md"),
        "utf8",
      ),
    ).toContain("And wrap long lines.");
    expect((await aireg(["registry", "validate"], { cwd: registryRoot })).code).toBe(0);
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
  }, 60_000);

  test("refuses a file that may hold credentials, and sends none of it", async ({ aireg }) => {
    await mkdir(join(work, "skills", "keyed"), { recursive: true });
    await writeFile(
      join(work, "skills", "keyed", "SKILL.md"),
      skillBody("keyed", "keyed", "Call the API.\n"),
    );
    await writeFile(join(work, "skills", "keyed", ".env"), "TOKEN=x\n");
    const sent = await aireg(["publish", "skills/keyed", "--to", "team/platform", "--yes"], {
      cwd: work,
    });
    expect(sent.code).toBe(1);
    expect(sent.stderr).toMatch(/keyed\/\.env may hold credentials/);
    expect(existsSync(join(registryRoot, "artifacts", "platform", "skill", "keyed"))).toBe(false);
  });

  test("refuses what `registry validate` would reject, and sends none of it", async ({ aireg }) => {
    await mkdir(join(work, "skills", "bare"), { recursive: true });
    await writeFile(
      join(work, "skills", "bare", "SKILL.md"),
      "---\nname: bare\n---\nNo summary.\n",
    );
    const bare = await aireg(["publish", "skills/bare", "--to", "team/platform", "--yes"], {
      cwd: work,
    });
    expect(bare.code).toBe(1);
    expect(bare.stderr).toMatch(/platform\/skill\/bare[\s\S]*`description` is required/);
    expect(existsSync(join(registryRoot, "artifacts", "platform", "skill", "bare"))).toBe(false);

    const renamed = ["publish", "skills/deploy", "--to", "team/platform/ship", "--yes"];
    const named = await aireg(renamed, { cwd: work });
    expect(named.code).toBe(1);
    expect(named.stderr).toMatch(/is named "deploy" in its front matter/);
  });

  test("refuses a name in --to that the registry would not take, rather than changing it", async ({
    aireg,
  }) => {
    const sent = await aireg(
      ["publish", "skills/lint", "--to", "team/platform/Lint Two", "--yes"],
      { cwd: work },
    );
    expect(sent.code).toBe(2);
    expect(sent.stderr).toMatch(/"Lint Two" is not a valid artifact name/);
    expect(sent.stderr).toMatch(/lint-two/);
  });

  test("publishes an agent from one file, and says what it sent under --json", async ({
    aireg,
  }) => {
    const sent = await aireg(
      ["publish", "agents/triage.md", "--to", "team/data", "--yes", "--json"],
      { cwd: work },
    );
    expect(sent.code, sent.stderr).toBe(0);
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
          // A first version adds every file it sends.
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

  test("sends an edit to an installed copy home, and the lock follows it", async ({
    aireg,
    project,
  }) => {
    expect((await aireg(["add", "team/platform", "-y"], { cwd: project })).code).toBe(0);
    await appendFile(
      join(project, ".claude", "skills", "deploy", "SKILL.md"),
      "Watch the rollout.\n",
    );
    expect((await aireg(["status"], { cwd: project })).code).toBe(3);

    const named = await aireg(["publish"], { cwd: project });
    expect(named.code).toBe(2);
    expect(named.stderr).toContain("deploy");

    const sent = await aireg(["publish", "--yes"], { cwd: project });
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stdout).toMatch(/update\s+platform\/skill\/deploy\s+0\.1\.0 → 0\.1\.1/);
    expect((await aireg(["status"], { cwd: project })).code).toBe(0);
  }, 60_000);

  test("publishes an installed copy named by its harness link", async ({ aireg, project }) => {
    await appendFile(join(project, ".claude", "skills", "deploy", "SKILL.md"), "Roll back.\n");

    const sent = await aireg(["publish", ".claude/skills/deploy", "--yes"], { cwd: project });
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stdout).toMatch(/update\s+platform\/skill\/deploy\s+0\.1\.1 → 0\.1\.2/);
  }, 60_000);

  test("refuses an edit made on a version something newer has replaced", async ({
    aireg,
    project,
  }) => {
    await appendFile(join(work, "skills", "lint", "SKILL.md"), "Newer upstream.\n");
    expect(
      (await aireg(["publish", "skills/lint", "--to", "team/platform", "--yes"], { cwd: work }))
        .code,
    ).toBe(0);
    await appendFile(join(project, ".claude", "skills", "lint", "SKILL.md"), "Older edit.\n");

    const behind = await aireg(["publish", "lint", "--yes"], { cwd: project });
    expect(behind.code).toBe(3);
    expect(behind.stderr).toMatch(/would drop the changes in/);

    expect((await aireg(["publish", "lint", "--yes", "--force"], { cwd: project })).code).toBe(0);
  }, 60_000);

  test("refuses a symlink in what it publishes or indexes, and leaves OS litter out", async ({
    aireg,
  }) => {
    const linked = join(work, "skills", "linked");
    await mkdir(join(work, "shared"), { recursive: true });
    await mkdir(linked);
    await writeFile(
      join(linked, "SKILL.md"),
      skillBody("linked", "linked", "Run scripts/run.sh.\n"),
    );
    await writeFile(join(linked, ".DS_Store"), "x");
    await symlink(join(work, "shared"), join(linked, "scripts"));
    const send = ["publish", "skills/linked", "--to", "team/platform", "--yes"];

    const refused = await aireg(send, { cwd: work });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "linked/scripts is a symlink; an artifact holds regular files only.",
    );
    await rm(join(linked, "scripts"));
    expect((await aireg(send, { cwd: work })).code).toBe(0);
    const version = join(registryRoot, "artifacts", "platform", "skill", "linked", "0.1.0");
    const envelope = JSON.parse(await readFile(join(version, "artifact.json"), "utf8"));
    expect(envelope.files.map((file: { path: string }) => file.path)).toEqual(["SKILL.md"]);

    await symlink(join(work, "shared"), join(version, "scripts"));
    for (const action of ["validate", "index"]) {
      const ran = await aireg(["registry", action, "-y"], { cwd: registryRoot });
      expect(ran.code, action).toBe(1);
      expect(ran.stdout + ran.stderr, action).toMatch(/linked\/0\.1\.0\/scripts:?\s+is a symlink/);
    }
    await rm(join(version, "scripts"));
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

describe("authoring versions in a registry", () => {
  const authored = () => join(root, "authored");
  const eng = () => join(authored(), "artifacts", "eng");
  const ship = (...rest: string[]) => join(eng(), "skill", "ship", ...rest);
  const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

  test("keeps latest on the highest version when a lower one is indexed after it", async ({
    aireg,
  }) => {
    const init = ["registry", "init", authored(), "--name", "authored", "--namespace", "eng"];
    expect((await aireg([...init, "-y"], { cwd: work })).code).toBe(0);
    expect((await aireg(["skill", "new", "ship"], { cwd: eng() })).code).toBe(0);
    await writeFile(ship("0.1.0", "SKILL.md"), "---\nname: ship\ndescription: Ship it.\n---\n");
    expect((await aireg(["skill", "bump", "ship", "major"], { cwd: eng() })).code).toBe(0);
    expect((await aireg(["registry", "index"], { cwd: authored() })).code).toBe(0);

    expect((await aireg(["skill", "bump", "ship", "0.1.1"], { cwd: eng() })).code).toBe(0);
    expect((await aireg(["registry", "index"], { cwd: authored() })).code).toBe(0);
    expect((await json(ship("versions.json"))).latest).toBe("1.0.0");
    expect((await json(join(authored(), "index.json"))).entries[0].latest).toBe("1.0.0");

    const versions = await json(ship("versions.json"));
    for (const row of versions.versions) row.status = "deprecated";
    await writeFile(ship("versions.json"), `${JSON.stringify(versions, null, 2)}\n`);
    const indexed = await aireg(["registry", "index"], { cwd: authored() });
    expect(indexed.stdout).toContain("Updated index.json. No new versions.");
  });

  test("writes a bump to a v-prefixed version as the bare version", async ({ aireg }) => {
    const bumped = await aireg(["skill", "bump", "ship", "v2.0.0"], { cwd: eng() });
    expect(bumped.code, bumped.stderr).toBe(0);
    expect(existsSync(ship("2.0.0"))).toBe(true);
    expect(existsSync(ship("v2.0.0"))).toBe(false);
  });

  test("names the namespace in the hint for a missing artifact, unless you are in it", async ({
    aireg,
  }) => {
    const outside = await aireg(["skill", "bump", "absent"], { cwd: authored() });
    expect(outside.stderr).toContain("`aireg skill new absent --namespace <namespace>`");
    const named = await aireg(["skill", "bump", "absent", "--namespace", "eng"], {
      cwd: authored(),
    });
    expect(named.stderr).toContain("`aireg skill new absent --namespace eng`");
    const inside = await aireg(["skill", "bump", "absent"], { cwd: eng() });
    expect(inside.stderr).toContain("`aireg skill new absent`.");
    const climbing = await aireg(["skill", "bump", "../../ship"], { cwd: eng() });
    expect(climbing.code).toBe(2);
    expect(climbing.stderr).toContain("is not a valid artifact name");
  });

  test("renames the copy new --from --name makes, so it indexes", async ({ aireg }) => {
    const source = join(root, "hello");
    await mkdir(source, { recursive: true });
    const text = "---\n# kept\nname: hello\ndescription: Say hello.\n---\n\nSay hello.\n";
    await writeFile(join(source, "SKILL.md"), text);
    const from = ["skill", "new", "--from", source, "--name", "greet", "--namespace", "eng", "-y"];
    const copied = await aireg(from, { cwd: authored() });
    expect(copied.code, copied.stderr).toBe(0);
    const greet = join(eng(), "skill", "greet", "0.1.0", "SKILL.md");
    expect(await readFile(greet, "utf8")).toBe(text.replace("name: hello", "name: greet"));
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toBe(text);
    expect((await aireg(["registry", "index"], { cwd: authored() })).code).toBe(0);
  });

  test("keeps an agent's dependencies through a bump, and checks they exist", async ({ aireg }) => {
    const agent = (version: string, ...rest: string[]) =>
      join(eng(), "agent", "planner", version, ...rest);
    await mkdir(agent("0.1.0"), { recursive: true });
    await writeFile(
      agent("0.1.0", "AGENT.md"),
      "---\nname: planner\ndescription: Plans a release.\n---\n\nPlan it.\n",
    );
    const needs = (to: string) =>
      JSON.stringify({ relationships: [{ rel_type: "depends_on", to }] });
    await writeFile(agent("0.1.0", "artifact.json"), needs("eng/skill/ship@1.0.0"));
    expect((await aireg(["registry", "index"], { cwd: authored() })).code).toBe(0);
    const edge = { rel_type: "depends_on", to: "eng/skill/ship@1.0.0" };
    expect((await json(agent("0.1.0", "artifact.json"))).relationships).toEqual([edge]);

    const bumped = await aireg(["agent", "bump", "planner"], { cwd: eng() });
    expect(bumped.stdout).toMatch(/1 relationship from 0\.1\.0/);
    expect((await aireg(["registry", "index"], { cwd: authored() })).code).toBe(0);
    expect((await json(agent("0.1.1", "artifact.json"))).relationships).toEqual([edge]);

    expect((await aireg(["agent", "bump", "planner"], { cwd: eng() })).code).toBe(0);
    await writeFile(agent("0.1.2", "artifact.json"), needs("eng/skill/ship@9.9.9"));
    const checked = await aireg(["registry", "validate"], { cwd: authored() });
    expect(checked.code).toBe(1);
    expect(checked.stdout).toContain(
      "depends on eng/skill/ship@9.9.9, which this registry does not hold",
    );
  });

  test("keeps a file the blob store holds through a bump", async ({ aireg }) => {
    const acme = join(root, "acme");
    await cp(join(import.meta.dirname, "../../../examples/acme-registry"), acme, {
      recursive: true,
    });
    const bumped = await aireg(["skill", "bump", "pr-review", "--namespace", "engineering"], {
      cwd: acme,
    });
    expect(bumped.stdout).toContain("1 blob-backed file from 1.2.0, in artifact.json");
    expect((await aireg(["registry", "index"], { cwd: acme })).code).toBe(0);
    const at = join(acme, "artifacts", "engineering", "skill", "pr-review", "1.2.1");
    const files = (await json(join(at, "artifact.json"))).files as { path: string }[];
    expect(files.map((file) => file.path)).toContain("assets/rubric.json");
    expect((await aireg(["registry", "validate"], { cwd: acme })).code).toBe(0);
  });

  test("refuses a name Windows reserves for a device, from new, validate and index", async ({
    aireg,
  }) => {
    const refused = await aireg(["skill", "new", "con"], { cwd: eng() });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('"con" is a device name on Windows.');

    const made = join(eng(), "skill", "lpt9", "0.1.0");
    await mkdir(made, { recursive: true });
    await writeFile(join(made, "SKILL.md"), "---\nname: lpt9\ndescription: Print.\n---\n");
    for (const action of ["validate", "index"]) {
      const ran = await aireg(["registry", action], { cwd: authored() });
      expect(ran.code, action).toBe(1);
      expect(ran.stdout + ran.stderr, action).toContain('"lpt9" is a device name on Windows');
    }
    await rm(join(eng(), "skill", "lpt9"), { recursive: true });
  });
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
  }, 60_000);

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

  test("reports a versions.json filed under another name, and a registry without files", async ({
    aireg,
  }) => {
    const versions = demo("versions.json");
    const before = await readFile(versions, "utf8");
    await edit(versions, (document) => {
      document.namespace = "other";
    });
    const moved = await validate(aireg);
    expect(moved.code).toBe(1);
    expect(moved.stdout).toMatch(/namespace is other, but its folder says eng/);
    await writeFile(versions, before);

    const registryJson = join(catalog(), "registry.json");
    const kept = await readFile(registryJson, "utf8");
    await edit(registryJson, (document) => {
      document.capabilities = undefined;
    });
    const bare = await validate(aireg);
    expect(bare.code).toBe(1);
    expect(bare.stdout).toMatch(/capabilities must include "files"/);
    await writeFile(registryJson, kept);
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

describe("registry init in a folder that is already a registry", () => {
  test("answers in the same JSON shape, with the slug and only the namespaces it added", async ({
    aireg,
  }) => {
    const reg = join(root, "again");
    const first = [
      "registry",
      "init",
      reg,
      "--name",
      "again",
      "--namespace",
      "one",
      "-y",
      "--json",
    ];
    expect(JSON.parse((await aireg(first)).stdout).data).toMatchObject({
      created: true,
      slug: "again",
    });
    const more = [
      "registry",
      "init",
      reg,
      "--namespace",
      "one",
      "--namespace",
      "two",
      "-y",
      "--json",
    ];
    expect(JSON.parse((await aireg(more)).stdout).data).toEqual({
      root: reg,
      created: false,
      slug: "again",
      namespaces: ["two"],
    });
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
      if (program === "git") await git(reg, ...args);
      else expect((await aireg(args, { cwd: reg })).code).toBe(0);
    }

    const fixed = await aireg(["registry", "validate", "--base", "main"], { cwd: reg });
    expect(fixed.code, fixed.stdout).toBe(0);
    expect(await readFile(skill("0.1.1"), "utf8")).toContain("stricter");
    expect(await readFile(skill("0.1.0"), "utf8")).not.toContain("stricter");
  });
});

// Last, because the namespace default these set is your own and every publish after reads it.
describe("publishing from a project", () => {
  test("refuses a git registry, and writes into a clone of it named by path", async ({
    aireg,
    git,
    home,
  }) => {
    const scratch = join(root, "push-new");
    const mp = join(root, "push-new-repo");
    const clone = join(root, "push-new-clone");
    await registry(mp).skill("acme/seed@1.0.0", { description: "s", body: "body\n" }).write();
    await git.init(mp);
    await git.commit(mp, "initial");
    await git(root, "clone", "-q", mp, clone);

    await mkdir(join(scratch, ".claude", "agents"), { recursive: true });
    await writeManifestIn(
      scratch,
      [
        "registries:",
        "  kit:",
        `    source: file://${mp}`,
        "artifacts:",
        "  - kit/acme/skill/seed",
      ].join("\n"),
    );
    expect((await aireg(["install"], { cwd: scratch })).code).toBe(0);
    await writeFile(
      join(scratch, ".claude", "agents", "hotfix.md"),
      "---\ndescription: Cut a hotfix.\n---\nBranch from the tag.\n",
    );

    const hotfix = join(".claude", "agents", "hotfix.md");
    const refused = await aireg(["publish", hotfix, "--to", "kit/mine", "--yes"], {
      cwd: scratch,
    });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/kit is a git registry, and aireg does not publish to git/);
    // With nowhere named and only kit declared, it says so before asking anything. An empty
    // user scope keeps the folder registries earlier tests declared out of the choice.
    const unnamed = await aireg(["publish", hotfix, "--yes"], {
      cwd: scratch,
      env: { AIREG_USER_SCOPE: join(root, "push-new-scope") },
    });
    expect(unnamed.code).toBe(2);
    expect(unnamed.stderr).toMatch(/kit is a git registry, and aireg does not publish to git/);

    const published = await aireg(["publish", hotfix, "--to", join(clone, "mine"), "--yes"], {
      cwd: scratch,
    });
    expect(published.code, published.stderr).toBe(0);
    const next = /next\s+(.+)$/m.exec(published.stdout)?.[1];
    expect(next).toBe(
      'cd ../push-new-clone && git add . && git commit -m "add hotfix 0.1.0" && git push',
    );
    // The clone's origin has its branch checked out, so everything but the push runs here.
    const commit = (next as string).replace(/ && git push$/, "");
    await exec("sh", ["-c", commit], { cwd: scratch, env: { ...process.env, ...home.env } });
    expect(await git(clone, "status", "--porcelain")).toBe("");
    expect(published.stdout).not.toContain("your user scope");
    // A registry stores a version directory with the envelope beside the
    // native file, so that is what a publish adds - not a loose `agents/` path.
    const at = (path: string) => readFile(join(clone, path), "utf8");
    // An agent goes in as AGENT.md, named and otherwise as written.
    const agent = await at("artifacts/mine/agent/hotfix/0.1.0/AGENT.md");
    expect(agent).toBe(
      "---\ndescription: Cut a hotfix.\nname: hotfix\n---\nBranch from the tag.\n",
    );
    expect(await at("artifacts/mine/agent/hotfix/0.1.0/artifact.json")).toContain(
      '"namespace": "mine"',
    );
    expect(await at("index.json")).toContain("hotfix");
    const again = await aireg(["publish", hotfix, "--to", join(clone, "mine"), "--yes"], {
      cwd: scratch,
    });
    expect(again.stdout).toMatch(/Nothing new to publish/);

    // The registry is named as --to gave it, whatever folder aireg runs from.
    const rollback = join(".claude", "agents", "rollback.md");
    await writeFile(join(scratch, rollback), "---\ndescription: Roll back.\n---\nRevert it.\n");
    for (const [to, named] of [
      [join(clone, "mine"), clone],
      [join(relative(scratch, clone), "mine"), relative(scratch, clone)],
    ] as const) {
      const planned = await aireg(
        ["publish", rollback, "--to", to, "--dry-run", "--yes", "--json"],
        { cwd: scratch },
      );
      expect(planned.code, planned.stderr).toBe(0);
      expect(JSON.parse(planned.stdout).data.artifacts[0].registry).toBe(named);
    }
  }, 60_000);

  test("keeps a copy sent with --force into a clone, and warns before update replaces it", async ({
    aireg,
    git,
  }) => {
    const scratch = join(root, "force-clone");
    const mp = join(root, "force-clone-repo");
    const clone = join(root, "force-clone-clone");
    const seed = registry(mp).skill("acme/seed@1.0.0", { body: "body\n" });
    await seed.write();
    await git.init(mp);
    await git.commit(mp, "initial");
    await git(root, "clone", "-q", mp, clone);
    await mkdir(join(scratch, ".claude"), { recursive: true });
    await writeManifestIn(
      scratch,
      `registries:\n  kit:\n    source: file://${mp}\nartifacts:\n  - kit/acme/skill/seed`,
    );
    expect((await aireg(["install"], { cwd: scratch })).code).toBe(0);
    // A teammate releases 1.0.1 after this copy was installed, and the clone pulls it.
    await seed.skill("acme/seed@1.0.1", { body: "theirs\n" }).write();
    await git.commit(mp, "seed 1.0.1");
    await git(clone, "pull", "-q");
    const copy = join(scratch, ".claude", "skills", "seed", "SKILL.md");
    await appendFile(copy, "Mine.\n");

    const sent = await aireg(["publish", "seed", "--to", join(clone, "acme"), "--yes", "--force"], {
      cwd: scratch,
    });
    expect(sent.code, sent.stderr).toBe(0);
    expect(await readFile(copy, "utf8")).toContain("Mine.");
    expect(sent.stderr).toMatch(/serves seed 1\.0\.1, not the 1\.0\.2 you published/);
  }, 60_000);

  test("refuses new work with no destination or an undeclared one, and takes your default namespace", async ({
    aireg,
    git,
  }) => {
    const repo = await gitRegistry(git, join(root, "push-to-kit"));
    const scratch = join(root, "push-to");
    const second = await registry(join(root, "push-to-second"))
      .skill("acme/other@1.0.0", { description: "o", body: "body\n" })
      .write();
    const at = { cwd: scratch };

    await mkdir(join(scratch, ".claude", "skills", "mine"), { recursive: true });
    await writeManifestIn(
      scratch,
      [
        "registries:",
        "  kit:",
        `    source: file://${repo}`,
        "  other:",
        `    source: ${second}`,
        "artifacts:",
        "  - kit/skill/lint",
      ].join("\n"),
    );
    expect((await aireg(["install"], at)).code).toBe(0);
    await writeFile(
      join(scratch, ".claude", "skills", "mine", "SKILL.md"),
      "---\nname: mine\ndescription: written here\n---\nlocal\n",
    );

    const mine = join(".claude", "skills", "mine");
    const nowhere = await aireg(["publish", mine, "--yes"], at);
    expect(nowhere.code).toBe(2);
    expect(nowhere.stderr).toMatch(/--to <registry>\/<namespace>/);

    const wrong = await aireg(["publish", mine, "--yes", "--to", "nope/acme"], at);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toMatch(/No registry named/);

    const chosen = await aireg(["publish", mine, "--yes", "--to", "other/acme"], at);
    expect(chosen.code, chosen.stderr).toBe(0);
    expect(
      await readFile(join(second, "artifacts/acme/skill/mine/0.1.0/SKILL.md"), "utf8"),
    ).toContain("local");
    // Where new work goes is your own default, never written into the project's manifest.
    expect(await readFile(join(scratch, ".registry", "manifest.yml"), "utf8")).not.toMatch(
      /^publish:/m,
    );

    await mkdir(join(scratch, ".claude", "skills", "more"), { recursive: true });
    await writeFile(
      join(scratch, ".claude", "skills", "more", "SKILL.md"),
      "---\nname: more\ndescription: written here\n---\nmore\n",
    );
    expect((await aireg(["config", "set", "defaults.namespace", "other/acme"], at)).code).toBe(0);
    const defaulted = await aireg(["publish", join(".claude", "skills", "more"), "--yes"], at);
    expect(defaulted.code, defaulted.stderr).toBe(0);
    expect(
      await readFile(join(second, "artifacts/acme/skill/more/0.1.0/SKILL.md"), "utf8"),
    ).toContain("more");
    // A default for a registry this project does not declare belongs to other projects.
    expect((await aireg(["config", "set", "defaults.namespace", "nope/acme"], at)).code).toBe(0);
    await mkdir(join(scratch, ".claude", "skills", "third"), { recursive: true });
    await writeFile(
      join(scratch, ".claude", "skills", "third", "SKILL.md"),
      "---\nname: third\ndescription: written here\n---\nthird\n",
    );
    const homeless = await aireg(["publish", join(".claude", "skills", "third"), "--yes"], at);
    expect(homeless.code).toBe(2);
    expect(homeless.stderr).toMatch(/--to <registry>\/<namespace>/);
  }, 60_000);
});
