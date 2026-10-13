import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { gitRegistry, registry } from "#test/kit/builders/registry.ts";
import { test as base } from "#test/kit/fixtures.ts";

const test = base.extend("repo", ({ git, tmp }) => gitRegistry(git, join(tmp, "kit")));

describe("stopping the daemon", () => {
  test("stops a run that waits on git, and exits 0", async ({ aireg, project, tmp, repo }) => {
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
  }, 60_000);
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
