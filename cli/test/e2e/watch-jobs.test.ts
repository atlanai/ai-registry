import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, type Home, test } from "#test/kit/fixtures.ts";

describe("a watch job over a namespace your user scope installs", () => {
  const body = (text: string) => `---\nname: notes\ndescription: Takes notes.\n---\n${text}\n`;
  const watching = async (
    { aireg, home, tmp }: { aireg: Aireg; home: Home; tmp: string },
    { published = true } = {},
  ) => {
    const reg = join(tmp, "reg");
    await registry(reg, { name: "demo", slug: "demo" }).skill("personal/hello@0.1.0").write();
    const notes = join(home.dir, ".claude", "skills", "notes", "SKILL.md");
    const versions = join(reg, "artifacts", "personal", "skill", "notes", "versions.json");
    expect((await aireg(["registry", "add", reg, "-g"])).code).toBe(0);
    expect((await aireg(["add", "-g", "demo/personal", "--yes"])).code).toBe(0);
    await mkdir(dirname(notes), { recursive: true });
    await writeFile(notes, body("Old."));
    const skills = dirname(dirname(notes));
    const added = await aireg(["job", "add", "-g", "--watch", skills, "--to", "demo/personal"]);
    expect(added.code, added.stderr).toBe(0);
    const job = /(?:Added|Updated) job (\S+),/.exec(added.stdout)?.[1] ?? "";
    const run = async () => {
      const id = /run_[0-9a-f-]+/.exec((await aireg(["job", "start", job])).stdout)?.[0] ?? "";
      const followed = (await aireg(["job", "runs", id, "--follow"])).stdout;
      expect(followed).toMatch(/finished\s+(succeeded|attention)/);
      return followed;
    };
    // A teammate's 0.1.1, published straight into the registry.
    const teammate = async () => {
      expect((await aireg(["skill", "bump", "notes", "patch", "-y"], { cwd: reg })).code).toBe(0);
      const next = join(reg, "artifacts", "personal", "skill", "notes", "0.1.1", "SKILL.md");
      await writeFile(next, body("Teammate."));
      expect((await aireg(["registry", "index"], { cwd: reg })).code).toBe(0);
    };
    // Tests about the job's configuration alone skip the first publish.
    const publishFirst = async () => {
      await run();
      expect(await readFile(versions, "utf8")).toContain('"0.1.0"');
    };
    if (published) await publishFirst();
    return { notes, versions, run, teammate, job };
  };

  test("publishes each edit as the next version, and goes on when its job is added again", async ({
    aireg,
    home,
    tmp,
  }) => {
    const { notes, versions, run } = await watching({ aireg, home, tmp });
    await writeFile(notes, body("New."));
    expect(await run()).toMatch(/published\s+personal\/notes/);
    expect(await readFile(versions, "utf8")).toContain('"0.1.1"');

    const again = await aireg(["job", "add", "-g", "--registry", "demo"]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("Updated job job_skills_demo, which publishes");
    await writeFile(notes, body("Again."));
    expect(await run()).toMatch(/published\s+personal\/notes/);
    expect(await readFile(versions, "utf8")).toContain('"0.1.2"');
  }, 120_000);

  test("never sends the folder back over a version someone else published", async ({
    aireg,
    home,
    tmp,
  }) => {
    const { notes, versions, run, teammate } = await watching({ aireg, home, tmp });
    await teammate();
    for (let round = 0; round < 2; round += 1) {
      expect(await run()).toMatch(/attention\s+personal\/notes\s+changed in demo/);
    }
    expect(await readFile(versions, "utf8")).not.toContain('"0.1.2"');
    expect(await readFile(notes, "utf8")).toContain("Old.");
  }, 120_000);

  test("holds an edit made against an older version until a person settles it", async ({
    aireg,
    home,
    tmp,
  }) => {
    const { notes, versions, run, teammate } = await watching({ aireg, home, tmp });
    await teammate();
    await writeFile(notes, body("New."));
    for (let round = 0; round < 2; round += 1) {
      expect(await run()).toMatch(/attention\s+personal\/notes/);
    }
    expect(await readFile(versions, "utf8")).not.toContain('"0.1.2"');

    // The dry run's hint, run exactly as printed.
    const dry = await aireg(["sync", "-g", "--dry-run"]);
    const printed = /`aireg (sync resolve [^`]+ --theirs)`/.exec(dry.stdout + dry.stderr)?.[1];
    expect(printed).toBe("sync resolve notes -g --theirs");
    const theirs = await aireg((printed ?? "").split(" "));
    expect(theirs.code, theirs.stderr).toBe(0);
    expect(await readFile(notes, "utf8")).toContain("Teammate.");
    const backups = join(home.scope, "backups");
    const kept = (await readdir(backups, { recursive: true })).filter((path) =>
      path.endsWith("SKILL.md"),
    );
    expect(await readFile(join(backups, kept[0] ?? ""), "utf8")).toContain("New.");
    expect(await run()).not.toMatch(/published/);
    expect(await readFile(versions, "utf8")).not.toContain('"0.1.2"');
  }, 120_000);

  const jobs = async (aireg: Aireg) =>
    (
      JSON.parse((await aireg(["job", "list", "--json"])).stdout) as {
        data: { jobs: { id: string; steps: { kind: string; policy: string }[] }[] };
      }
    ).data.jobs;

  test("stops watching a folder and keeps the job that keeps the install up to date", async ({
    aireg,
    home,
    tmp,
  }) => {
    const { notes, versions, run } = await watching({ aireg, home, tmp });
    const skills = dirname(dirname(notes));
    const unwatched = await aireg(["watch", "remove", skills, "-g"]);
    expect(unwatched.code, unwatched.stderr).toBe(0);
    const steps = (await jobs(aireg)).map((item) =>
      item.steps.map((step) => `${step.kind} ${step.policy}`),
    );
    expect(steps).toEqual([["pull on", "publish report", "prune report"]]);

    await writeFile(notes, body("New."));
    expect(await run()).not.toMatch(/published/);
    expect(await readFile(versions, "utf8")).not.toContain('"0.1.1"');
  }, 120_000);

  test("refuses to send a watched scope's folders somewhere else", async ({ aireg, home, tmp }) => {
    const { notes } = await watching({ aireg, home, tmp }, { published: false });
    const before = await jobs(aireg);
    const drafts = join(home.dir, "drafts");
    await mkdir(drafts, { recursive: true });
    const moved = await aireg(["watch", "add", drafts, "--to", "demo/other", "-g"]);
    expect(moved.code).toBe(2);
    expect(moved.stderr).toContain(`already publishes ${dirname(dirname(notes))} to demo/personal`);
    expect(await jobs(aireg)).toEqual(before);
  }, 120_000);

  test("says when removing a job leaves what it kept up to date without one", async ({
    aireg,
    home,
    tmp,
  }) => {
    const { job } = await watching({ aireg, home, tmp }, { published: false });
    const removed = await aireg(["job", "remove", job]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.stderr).toContain("no longer kept up to date");

    // The hint, run exactly as printed.
    const printed = /`aireg (job add -g --registry demo)`/.exec(removed.stderr)?.[1];
    expect(printed).toBeDefined();
    expect((await aireg((printed ?? "").split(" "))).code).toBe(0);
    expect((await jobs(aireg)).map((item) => item.steps.map((step) => step.kind))).toEqual([
      ["pull", "publish", "prune"],
    ]);
  }, 120_000);

  test("settles a job's conflict by the short name the hints print", async ({
    aireg,
    home,
    tmp,
  }) => {
    const { notes, versions, run, teammate, job } = await watching({ aireg, home, tmp });
    await teammate();
    await writeFile(notes, body("New."));
    expect(await run()).toMatch(/attention\s+personal\/notes/);

    const mine = await aireg(["sync", "resolve", "notes", "--mine", "--job", job]);
    expect(mine.code, mine.stderr).toBe(0);
    expect(await readFile(versions, "utf8")).toContain('"0.1.2"');
    expect(await run()).not.toMatch(/attention/);
  }, 120_000);
});
