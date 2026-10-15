import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, vi } from "vitest";
import { type Aireg, type Git, fileTest as test } from "#test/kit/fixtures.ts";

let aireg: Aireg;
let git: Git;
let root: string;
let home: string;

test.beforeAll(({ aireg: run, git: gitIn, tmp, home: { dir } }) => {
  [aireg, git, root, home] = [run, gitIn, tmp, dir];
});

afterAll(async () => {
  await aireg(["daemon", "stop"], { cwd: home });
});

describe("setting up a project in one command", () => {
  test("watches the project scope it set up", async () => {
    const made = await aireg(["registry", "init", join(root, "registry"), "--name", "team", "-y"], {
      cwd: home,
    });
    expect(made.code, made.stderr).toBe(0);
    expect(
      (await aireg(["registry", "add", join(root, "registry"), "-g"], { cwd: home })).code,
    ).toBe(0);
    await mkdir(join(root, "work", "lint"), { recursive: true });
    await writeFile(
      join(root, "work", "lint", "SKILL.md"),
      "---\nname: lint\ndescription: lint\n---\nRun the linter.\n",
    );
    const sent = await aireg(
      ["publish", join(root, "work", "lint"), "--to", "team/platform", "--yes", "-g"],
      { cwd: home },
    );
    expect(sent.code, sent.stderr).toBe(0);

    // A registry that already exists, in a project that has declared nothing.
    const project = join(root, "watched");
    await mkdir(project);
    await git.init(project);
    const setup = await aireg(
      ["init", "--registry", join(root, "registry"), "--as", "team", "--watch", "--yes"],
      { cwd: project },
    );
    expect(setup.code, `${setup.stdout}\n${setup.stderr}`).toBe(0);
    expect(setup.stdout).toMatch(/watching\s+every 15 minutes/);

    const jobs = await aireg(["job", "list", "--json"], { cwd: home });
    const { data } = JSON.parse(jobs.stdout) as {
      data: { jobs: { schedule: { every: number } }[] };
    };
    expect(data.jobs.map((job) => job.schedule.every)).toEqual([900]);
  }, 120_000);

  test("reads a skill a watched folder published as published", async () => {
    const project = join(root, "watched");
    const skill = "---\nname: probe\ndescription: probe\n---\nReply probe.\n";
    await mkdir(join(project, ".cursor", "skills", "probe"), { recursive: true });
    await writeFile(join(project, ".cursor", "skills", "probe", "SKILL.md"), skill);
    // The project already has a job, so this replaces the one `init` added.
    const added = await aireg(
      ["job", "add", "--watch", ".cursor/skills", "--to", "team/platform"],
      { cwd: project },
    );
    const job = /Added job (\S+),/.exec(added.stdout)?.[1] ?? "";
    const id = /run_[0-9a-f-]+/.exec(
      (await aireg(["job", "start", job], { cwd: project })).stdout,
    )?.[0];
    let state: string | undefined;
    await vi.waitFor(
      async () => {
        const runs = JSON.parse(
          (await aireg(["job", "runs", "--json"], { cwd: project })).stdout,
        ) as {
          data: { runs: { id: string; state: string }[] };
        };
        state = runs.data.runs.find((run) => run.id === id)?.state;
        if (state !== "succeeded") throw new Error(`the run is ${state ?? "not listed"}`);
      },
      { interval: 1000, timeout: 60_000 },
    );
    expect(state).toBe("succeeded");

    // Each event in words, one line per artifact, and no progress noise.
    const events = await aireg(["job", "runs", id ?? ""], { cwd: project });
    expect(events.stdout).toMatch(/^ {2}reading the registry$/m);
    // The job's own first run may import it before this one starts; the list below checks the result.
    expect(events.stdout).toMatch(
      /^ {2}(imported\s+probe\s+from .*\.cursor[\\/]skills[\\/]probe|unchanged\s+platform\/probe)$/m,
    );
    expect(events.stdout).toMatch(/^ {2}finished\s+succeeded$/m);
    expect(events.stdout).not.toMatch(/run\.phase|artifact\.progress/);

    expect((await aireg(["outdated"], { cwd: project })).code).toBe(0);
    const listed = JSON.parse((await aireg(["list", "--json"], { cwd: project })).stdout) as {
      data: { artifacts: { name: string; ref: string; watched?: unknown }[] };
    };
    expect(listed.data.artifacts.find((row) => row.name === "platform/probe")).toMatchObject({
      ref: "0.1.0",
      watched: { harness: "cursor", path: ".cursor/skills/probe" },
    });

    await mkdir(join(root, "elsewhere", "probe"), { recursive: true });
    await writeFile(join(root, "elsewhere", "probe", "SKILL.md"), `${skill}Theirs.\n`);
    await aireg(
      ["publish", join(root, "elsewhere", "probe"), "--to", "team/platform", "--yes", "-g"],
      { cwd: home },
    );
    const behind = await aireg(["outdated"], { cwd: project });
    expect(behind.code).toBe(3);
    expect(behind.stdout).toMatch(/probe\s+team\s+0\.1\.0 watched\s+0\.1\.1/);
    expect(behind.stdout).not.toContain("aireg update");
    expect(behind.stderr).toContain("aireg sync --dry-run");

    // The job goes on reading the folder, so removing everything keeps its row, and says so.
    const removed = await aireg(["remove", "--all", "--dry-run"], { cwd: project });
    expect(removed.stderr).toContain("Kept probe, which a job publishes from your own folder.");
    const json = await aireg(["remove", "--all", "--dry-run", "--json"], { cwd: project });
    expect(JSON.parse(json.stdout).data).toMatchObject({ watched: ["platform/probe"] });

    // Once no job watches the folder, aireg forgets the copy it kept, and the folder stays.
    expect((await aireg(["job", "remove", job], { cwd: project })).code).toBe(0);
    const after = JSON.parse((await aireg(["list", "--json"], { cwd: project })).stdout) as {
      data: { artifacts: { name: string }[] };
    };
    expect(after.data.artifacts.map((row) => row.name)).not.toContain("platform/probe");
    expect(
      existsSync(join(project, ".registry", "artifacts", "team", "platform", "skills", "probe")),
    ).toBe(false);
    expect(existsSync(join(project, ".cursor", "skills", "probe", "SKILL.md"))).toBe(true);
    const left = await aireg(["remove", "--all", "--dry-run"], { cwd: project });
    expect(left.stderr).not.toContain("which a job publishes");
  }, 120_000);

  test("imports an agent and publishes it into the registry", async () => {
    const project = join(root, "importing");
    await mkdir(join(project, ".claude", "agents"), { recursive: true });
    await git.init(project);
    await writeFile(
      join(project, ".claude", "agents", "helper.md"),
      "---\nname: helper\ndescription: Helps.\n---\nHelp.\n",
    );
    const setup = await aireg(
      [
        "init",
        "--registry",
        join(root, "registry"),
        "--as",
        "team",
        "--publish-to",
        "team/platform",
        "--import",
        "claude",
        "--yes",
      ],
      { cwd: project },
    );
    expect(setup.code, `${setup.stdout}\n${setup.stderr}`).toBe(0);
    const published = join(root, "registry", "artifacts", "platform", "agent", "helper", "0.1.0");
    expect(existsSync(join(published, "AGENT.md"))).toBe(true);
  }, 120_000);
});
