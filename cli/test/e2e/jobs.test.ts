import { chmod, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect } from "vitest";
import { gitRegistry, registry } from "#test/kit/builders/registry.ts";
import { type Aireg, test as base, type Home } from "#test/kit/fixtures.ts";

const test = base.extend("repo", ({ git, tmp }) => gitRegistry(git, join(tmp, "kit")));

describe("stopping the daemon", () => {
  // The stand-in git is a shell script, which Windows does not run.
  test.skipIf(process.platform === "win32")(
    "stops a run that waits on git, and exits 0",
    async ({ aireg, project, tmp, repo }) => {
      const bin = join(tmp, "hung-git");
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, "git"), "#!/bin/sh\nexec sleep 30\n");
      await chmod(join(bin, "git"), 0o755);
      await aireg(["init", "--for", "claude"]);
      const added = await aireg(["add", `file://${repo}`, "--as", "kit"]);
      expect(added.code, added.stderr).toBe(0);

      // The daemon this starts inherits the git that never answers.
      const hung = { env: { PATH: `${bin}:${process.env.PATH ?? ""}` } };
      try {
        expect((await aireg(["job", "add", "--registry", "kit"], hung)).code).toBe(0);
        const state = async () => {
          const runs = JSON.parse((await aireg(["job", "runs", "--json"])).stdout) as {
            data: { runs: { state: string }[] };
          };
          return runs.data.runs[0]?.state;
        };
        await expect.poll(state, { interval: 100, timeout: 10_000 }).toBe("running");

        const stopped = await aireg(["daemon", "stop"], { cwd: project });
        expect(stopped.code, stopped.stderr).toBe(0);
      } finally {
        await aireg(["daemon", "stop"]);
      }
    },
    60_000,
  );
});

describe("background sync jobs", () => {
  test("adds a job per folder, the user scope included", async ({ aireg, home, tmp, repo }) => {
    const folders = [join(tmp, "jobs", "a"), join(tmp, "jobs", "b")];
    try {
      for (const cwd of folders) {
        await mkdir(cwd, { recursive: true });
        await aireg(["init", "--for", "claude"], { cwd });
        const added = await aireg(["add", `file://${repo}`, "--as", "kit"], { cwd });
        expect(added.code, added.stderr).toBe(0);
        const job = await aireg(["job", "add", "--registry", "kit"], { cwd });
        expect(job.code, job.stderr).toBe(0);
      }
      const user = await aireg(["add", `file://${repo}`, "--as", "kit", "-g"], { cwd: tmp });
      expect(user.code, user.stderr).toBe(0);
      expect(user.stdout).toContain("up to date every 15 minutes");

      const listed = JSON.parse((await aireg(["job", "list", "--json"], { cwd: tmp })).stdout) as {
        data: { jobs: { id: string; steps: { root?: string }[] }[] };
      };
      const synced = listed.data.jobs.map((job) => [job.id, job.steps[0]?.root]);
      expect(synced).toEqual([
        ["job_skills_kit", await realpath(folders[0] as string)],
        ["job_skills_kit-b", await realpath(folders[1] as string)],
        ["job_skills_kit-user", await realpath(home.scope)],
      ]);

      // Read by a person, so the user scope is a home path, as every other command prints it.
      const text = await aireg(["job", "list"], { cwd: tmp });
      expect(text.stdout).toMatch(/job_skills_kit-user\s+kit\s+~\/\.registry\s/);

      // `job runs` starts a stopped daemon, as every other job command does.
      expect((await aireg(["daemon", "stop"], { cwd: tmp })).code).toBe(0);
      const runs = await aireg(["job", "runs", "--json"], { cwd: tmp });
      expect(runs.code, runs.stderr).toBe(0);
      expect(JSON.parse(runs.stdout)).toMatchObject({ ok: true });
    } finally {
      await aireg(["daemon", "stop"], { cwd: tmp });
    }
  }, 120_000);

  test("adds the user scope's job under --json too", async ({ aireg, tmp, repo }) => {
    try {
      const added = await aireg(["add", `file://${repo}`, "--as", "kit", "-g", "--json"], {
        cwd: tmp,
      });
      expect(added.code, added.stderr).toBe(0);
      expect(JSON.parse(added.stdout).data.jobId).toBe("job_skills_kit");
      const listed = JSON.parse((await aireg(["job", "list", "--json"], { cwd: tmp })).stdout) as {
        data: { jobs: { id: string }[] };
      };
      expect(listed.data.jobs.map((job) => job.id)).toEqual(["job_skills_kit"]);
    } finally {
      await aireg(["daemon", "stop"], { cwd: tmp });
    }
  }, 60_000);
});

describe("removing a registry", () => {
  const jobIds = async (aireg: Aireg, cwd: string) =>
    (
      JSON.parse((await aireg(["job", "list", "--json"], { cwd })).stdout) as {
        data: { jobs: { id: string }[] };
      }
    ).data.jobs.map((job) => job.id);

  test("takes the jobs that sync from it into that scope, and no other", async ({
    aireg,
    tmp,
    repo,
  }) => {
    const project = join(tmp, "app");
    await mkdir(project, { recursive: true });
    try {
      const user = await aireg(["add", `file://${repo}`, "--as", "kit", "-g"], { cwd: tmp });
      expect(user.code, user.stderr).toBe(0);
      await aireg(["init", "--for", "claude"], { cwd: project });
      const declared = await aireg(["registry", "add", `file://${repo}`, "--as", "kit"], {
        cwd: project,
      });
      expect(declared.code, declared.stderr).toBe(0);
      expect((await aireg(["job", "add", "--registry", "kit"], { cwd: project })).code).toBe(0);
      const projectJob = (await jobIds(aireg, tmp)).find((id) => id !== "job_skills_kit");

      const planned = await aireg(["registry", "remove", "kit", "--dry-run"], { cwd: project });
      expect(planned.stdout).toContain(
        `Would remove registry kit and its background job ${projectJob}.`,
      );
      expect(await jobIds(aireg, tmp)).toHaveLength(2);

      const removed = await aireg(["registry", "remove", "kit", "--json"], { cwd: project });
      expect(removed.code, removed.stderr).toBe(0);
      expect(JSON.parse(removed.stdout).data.jobs).toEqual([projectJob]);
      expect(await jobIds(aireg, tmp)).toEqual(["job_skills_kit"]);

      // Counted by what is installed: the one `kit` entry installs two artifacts.
      const needed = await aireg(["registry", "remove", "kit", "-g"], { cwd: tmp });
      expect(needed.code).toBe(1);
      expect(needed.stderr).toContain("Registry kit still provides 2 installed artifacts.");

      expect((await aireg(["remove", "--all", "-g", "-y"], { cwd: tmp })).code).toBe(0);
      const gone = await aireg(["registry", "remove", "kit", "-g"], { cwd: tmp });
      expect(gone.code, gone.stderr).toBe(0);
      expect(gone.stdout).toContain("Removed registry kit and its background job job_skills_kit.");
      expect(await jobIds(aireg, tmp)).toEqual([]);
    } finally {
      await aireg(["daemon", "stop"], { cwd: tmp });
    }
  }, 120_000);

  test("keeps a registry a watch job publishes to", async ({ aireg, home, tmp }) => {
    const reg = join(tmp, "reg");
    await registry(reg, { name: "demo", slug: "demo" }).skill("personal/hello@0.1.0").write();
    const mine = join(home.dir, "mine");
    await mkdir(join(mine, "notes"), { recursive: true });
    await writeFile(join(mine, "notes", "SKILL.md"), "---\nname: notes\ndescription: N.\n---\n");
    try {
      expect((await aireg(["registry", "add", reg, "-g"])).code).toBe(0);
      const watch = await aireg(["job", "add", "-g", "--watch", mine, "--to", "demo/personal"]);
      expect(watch.code, watch.stderr).toBe(0);

      const refused = await aireg(["registry", "remove", "demo", "-g"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(
        "Job job_skills_demo uses registry demo to publish your folders.",
      );
      expect(refused.stderr).toContain("aireg job remove job_skills_demo");
      expect(await jobIds(aireg, tmp)).toEqual(["job_skills_demo"]);
      expect(await readFile(join(home.scope, "manifest.yml"), "utf8")).toContain("demo:");
    } finally {
      await aireg(["daemon", "stop"], { cwd: tmp });
    }
  }, 60_000);
});

describe("a job for a registry the project declares by a relative folder", () => {
  test("declares it for your user scope at the same folder", async ({ aireg, home, tmp }) => {
    const work = join(tmp, "work");
    const project = join(work, "app");
    await registry(join(work, "reg"), { name: "acme", slug: "acme" })
      .skill("eng/pr-review@1.0.0")
      .write();
    await mkdir(project, { recursive: true });
    try {
      await aireg(["init", "--for", "claude"], { cwd: project });
      expect(
        (await aireg(["registry", "add", "../reg", "--as", "acme"], { cwd: project })).code,
      ).toBe(0);
      const job = await aireg(["job", "add", "--registry", "acme"], { cwd: project });
      expect(job.code, job.stderr).toBe(0);
      const user = await readFile(join(home.scope, "manifest.yml"), "utf8");
      expect(user).toContain(`acme: ${await realpath(join(work, "reg"))}`);
      const found = await aireg(["search", "pr-review"], { cwd: tmp });
      expect(found.code, found.stderr).toBe(0);
      expect(found.stdout).toContain("pr-review");
    } finally {
      await aireg(["daemon", "stop"], { cwd: tmp });
    }
  }, 60_000);
});

describe("a job that also declares artifacts with -s", () => {
  test("declares each by its full address, once, and refuses a name the registry lacks", async ({
    aireg,
    tmp,
  }) => {
    const work = join(tmp, "work");
    const project = join(work, "app");
    await registry(join(work, "reg"), { name: "acme", slug: "acme" })
      .skill("eng/pr-review@1.0.0")
      .skill("eng/lint@1.0.0")
      .write();
    await mkdir(project, { recursive: true });
    const manifest = join(project, ".registry", "manifest.yml");
    try {
      await aireg(["init", "--for", "claude"], { cwd: project });
      expect(
        (await aireg(["add", "../reg", "--as", "acme", "-s", "lint"], { cwd: project })).code,
      ).toBe(0);

      const job = await aireg(["job", "add", "--registry", "acme", "-s", "pr-review"], {
        cwd: project,
      });
      expect(job.code, job.stderr).toBe(0);
      const declared = await readFile(manifest, "utf8");
      expect(declared).toContain(
        "artifacts:\n  - acme/eng/skill/lint\n  - acme/eng/skill/pr-review\n",
      );

      const again = ["job", "add", "--registry", "acme", "-s", "eng/pr-review", "-s", "lint"];
      expect((await aireg(again, { cwd: project })).code).toBe(0);
      expect(await readFile(manifest, "utf8")).toBe(declared);

      const missing = await aireg(["job", "add", "--registry", "acme", "-s", "nope"], {
        cwd: project,
      });
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('acme publishes nothing named "nope".');
      expect(await readFile(manifest, "utf8")).toBe(declared);

      const listed = await aireg(["list"], { cwd: project });
      expect(listed.code, listed.stderr).toBe(0);
    } finally {
      await aireg(["daemon", "stop"], { cwd: tmp });
    }
  }, 60_000);
});

describe("a watch job over a namespace your user scope installs", () => {
  const body = (text: string) => `---\nname: notes\ndescription: Takes notes.\n---\n${text}\n`;
  const watching = async ({ aireg, home, tmp }: { aireg: Aireg; home: Home; tmp: string }) => {
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
    const job = /Added job (\S+),/.exec(added.stdout)?.[1] ?? "";
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
    await run();
    expect(await readFile(versions, "utf8")).toContain('"0.1.0"');
    return { notes, versions, run, teammate, job };
  };

  test("publishes each edit as the next version, and says so", async ({ aireg, home, tmp }) => {
    try {
      const { notes, versions, run } = await watching({ aireg, home, tmp });
      await writeFile(notes, body("New."));
      expect(await run()).toMatch(/published\s+personal\/notes/);
      expect(await readFile(versions, "utf8")).toContain('"0.1.1"');
    } finally {
      await aireg(["daemon", "stop"]);
    }
  }, 120_000);

  test("never sends the folder back over a version someone else published", async ({
    aireg,
    home,
    tmp,
  }) => {
    try {
      const { notes, versions, run, teammate } = await watching({ aireg, home, tmp });
      await teammate();
      for (let round = 0; round < 2; round += 1) {
        expect(await run()).toMatch(/attention\s+personal\/notes\s+changed in demo/);
      }
      expect(await readFile(versions, "utf8")).not.toContain('"0.1.2"');
      expect(await readFile(notes, "utf8")).toContain("Old.");
    } finally {
      await aireg(["daemon", "stop"]);
    }
  }, 120_000);

  test("holds an edit made against an older version until a person settles it", async ({
    aireg,
    home,
    tmp,
  }) => {
    try {
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
    } finally {
      await aireg(["daemon", "stop"]);
    }
  }, 120_000);

  test("settles a job's conflict by the short name the hints print", async ({
    aireg,
    home,
    tmp,
  }) => {
    try {
      const { notes, versions, run, teammate, job } = await watching({ aireg, home, tmp });
      await teammate();
      await writeFile(notes, body("New."));
      expect(await run()).toMatch(/attention\s+personal\/notes/);

      const mine = await aireg(["sync", "resolve", "notes", "--mine", "--job", job]);
      expect(mine.code, mine.stderr).toBe(0);
      expect(await readFile(versions, "utf8")).toContain('"0.1.2"');
      expect(await run()).not.toMatch(/attention/);
    } finally {
      await aireg(["daemon", "stop"]);
    }
  }, 120_000);
});
