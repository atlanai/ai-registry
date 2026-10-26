import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { gitRegistry, registry } from "#test/kit/builders/registry.ts";
import { type Aireg, test as base } from "#test/kit/fixtures.ts";

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
      await aireg(["init", "--for", "claude-code"]);
      const added = await aireg(["add", `file://${repo}`, "--as", "kit"]);
      expect(added.code, added.stderr).toBe(0);

      // The daemon this starts inherits the git that never answers.
      const hung = { env: { PATH: `${bin}:${process.env.PATH ?? ""}` } };
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
    },
  );
});

describe("background sync jobs", () => {
  test("adds a job per folder, the user scope included", async ({ aireg, home, tmp, repo }) => {
    const folders = [join(tmp, "jobs", "a"), join(tmp, "jobs", "b")];
    for (const cwd of folders) {
      await mkdir(cwd, { recursive: true });
      await aireg(["init", "--for", "claude-code"], { cwd });
      // Declared, not installed: a job is added for the registry, whatever it installs.
      const declared = await aireg(["registry", "add", `file://${repo}`, "--as", "kit"], { cwd });
      expect(declared.code, declared.stderr).toBe(0);
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
  }, 120_000);

  test("adds the user scope's job under --json too", async ({ aireg, tmp, repo }) => {
    const added = await aireg(["add", `file://${repo}`, "--as", "kit", "-g", "--json"], {
      cwd: tmp,
    });
    expect(added.code, added.stderr).toBe(0);
    expect(JSON.parse(added.stdout).data.jobId).toBe("job_skills_kit");
    const listed = JSON.parse((await aireg(["job", "list", "--json"], { cwd: tmp })).stdout) as {
      data: { jobs: { id: string }[] };
    };
    expect(listed.data.jobs.map((job) => job.id)).toEqual(["job_skills_kit"]);
  });
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
    const user = await aireg(["add", `file://${repo}`, "--as", "kit", "-g"], { cwd: tmp });
    expect(user.code, user.stderr).toBe(0);
    await aireg(["init", "--for", "claude-code"], { cwd: project });
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
  }, 120_000);

  test("keeps a registry a watch job publishes to", async ({ aireg, home, tmp }) => {
    const reg = join(tmp, "reg");
    await registry(reg, { name: "demo", slug: "demo" }).skill("personal/hello@0.1.0").write();
    const mine = join(home.dir, "mine");
    await mkdir(join(mine, "notes"), { recursive: true });
    await writeFile(join(mine, "notes", "SKILL.md"), "---\nname: notes\ndescription: N.\n---\n");
    expect((await aireg(["registry", "add", reg, "-g"])).code).toBe(0);
    const watch = await aireg(["job", "add", "-g", "--watch", mine, "--to", "demo/personal"]);
    expect(watch.code, watch.stderr).toBe(0);

    const refused = await aireg(["registry", "remove", "demo", "-g"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "Job job_skills_demo uses registry demo to publish your folders.",
    );
    // Written as the person reads it, and runnable as printed.
    expect(refused.stderr).toContain("aireg watch remove ~/mine -g");
    expect(await jobIds(aireg, tmp)).toEqual(["job_skills_demo"]);
    expect(await readFile(join(home.scope, "manifest.yml"), "utf8")).toContain("demo:");
  });
});

describe("a job for a registry the project declares by a relative folder", () => {
  test("declares it for your user scope at the same folder", async ({ aireg, home, tmp }) => {
    const work = join(tmp, "work");
    const project = join(work, "app");
    await registry(join(work, "reg"), { name: "acme", slug: "acme" })
      .skill("eng/pr-review@1.0.0")
      .write();
    await mkdir(project, { recursive: true });
    await aireg(["init", "--for", "claude-code"], { cwd: project });
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
  });
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
    await aireg(["init", "--for", "claude-code"], { cwd: project });
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
  });
});

describe("a job whose selector names a target by its aireg 0.1 id", () => {
  test("is disabled and enabled again, and keeps its selector", async ({ aireg, home, tmp }) => {
    const skills = join(tmp, "skills");
    await mkdir(skills, { recursive: true });
    const config = join(home.aireg, "config.yml");
    await mkdir(home.aireg, { recursive: true });
    await writeFile(
      config,
      [
        "schemaVersion: 1",
        "revision: 0",
        "accounts:",
        "  - { id: acc_local, registry: local }",
        "jobs:",
        "  - id: job_watch",
        "    account: acc_local",
        "    schedule: { every: 3600, enabled: false }",
        "    steps:",
        `      - { name: mine, kind: origins, to: local/mine, select: [{ from: ${JSON.stringify(skills)}, harness: [claude] }] }`,
        "",
      ].join("\n"),
    );
    for (const action of ["enable", "disable"]) {
      const changed = await aireg(["job", action, "job_watch"], { cwd: tmp });
      expect(changed.code, changed.stderr).toBe(0);
    }
    const written = await readFile(config, "utf8");
    expect(written).toContain("harness:\n              - claude\n");
    expect(written).not.toContain("target");
    expect(written).toContain("enabled: false");
  }, 60_000);
});
