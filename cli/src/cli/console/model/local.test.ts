import { mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import type { Carrier } from "#core/console/runs.ts";
import { emptyLock, type Lock } from "#core/lock.ts";
import type { Roots } from "#core/store/paths.ts";
import type { Targets } from "#core/target/contract.ts";
import { test } from "#test/kit/fixtures.ts";
import { type Carried, localWork } from "./local.ts";

let root: string;

/** One target whose skills live in `skills/`, which is all this reads. */
function targetTable(): Targets {
  return {
    "claude-code": {
      name: "claude-code",
      aliases: ["claude-code"],
      displayName: "Claude Code",
      projectRoot: join(root, "project"),
      userRoot: root,
      envHome: undefined,
      envWithin: undefined,
      detect: { env: [], binary: [], paths: [] },
      kinds: { skill: { subdir: "skills", shape: "directory" } },
      reads: {},
      category: "coding-agent",
      shared: false,
      verified: undefined,
      trust: {},
      reload: undefined,
      origin: "built-in",
    },
  };
}

async function skill(name: string): Promise<void> {
  await mkdir(join(root, "skills", name), { recursive: true });
  await writeFile(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
}

/** Your user scope, rooted where these target folders are. */
function scope(): Roots {
  return {
    scope: "user",
    cwd: root,
    base: root,
    artifacts: join(root, ".registry", "artifacts"),
  } as Roots;
}

function locked(name: string, source = "acme"): Lock {
  const lock = emptyLock();
  lock.artifacts[`my-team/${name}`] = {
    name,
    kind: "skill",
    registry: source,
    namespace: "my-team",
    links: [],
  } as unknown as Lock["artifacts"][string];
  return lock;
}

function carried(name: string, over: Partial<Carrier> = {}): Carried {
  return new Map([
    [
      join(root, "skills", name),
      {
        job: "import-local",
        jobId: "job_import",
        settledAtMs: Date.now() + 60_000,
        outcome: "unchanged",
        detail: undefined,
        ...over,
      },
    ],
  ]);
}

test.beforeEach(async ({ tmp }) => {
  root = tmp;
  await mkdir(join(root, "skills"), { recursive: true });
});

describe("localWork", () => {
  test("reads work nothing knows about as never sent", async () => {
    await skill("mine");
    const [row] = await localWork(scope(), targetTable(), emptyLock());
    expect(row?.state).toBe("unpublished");
  });

  // The state a push leaves behind.
  test("reads work the manifest declares as published and waiting to be tracked", async () => {
    await skill("mine");
    const [row] = await localWork(scope(), targetTable(), emptyLock(), new Set(["mine"]));
    expect(row?.state).toBe("pending");
    expect(row?.detail).toContain("run `aireg install`");
  });

  test("lets the lock win once the artifact is installed under its namespace", async () => {
    await skill("mine");
    const [row] = await localWork(scope(), targetTable(), locked("mine"), new Set(["mine"]));
    expect(row?.state).toBe("duplicate");
    expect(row?.detail).toContain("same name as acme/");
  });

  test("offers nothing for a name a registry already publishes", async () => {
    await skill("mine");
    const [row] = await localWork(scope(), targetTable(), locked("mine"));
    expect(row?.state).toBe("duplicate");
    expect(row?.detail).toContain("rename this folder to publish it");
  });

  // Every lock row comes from a registry, whatever name it was declared under.
  test("names a registry aliased local like any other", async () => {
    await skill("mine");
    const [row] = await localWork(scope(), targetTable(), locked("mine", "local"));
    expect(row?.detail).toContain("same name as local/");
    expect(row?.detail).not.toContain("local folder");
  });

  test("reads a folder a job already carries as imported, not as never sent", async () => {
    await skill("mine");
    const [row] = await localWork(scope(), targetTable(), emptyLock(), new Set(), carried("mine"));
    expect(row?.state).toBe("imported");
    expect(row?.carriedBy).toBe("job_import");
    expect(row?.detail).toBe("carried by job import-local");
  });

  test("reports a carried folder edited since the job last ran, for that job to take", async () => {
    await skill("mine");
    const past = new Date(Date.now() - 3_600_000);
    await utimes(join(root, "skills", "mine"), past, past);
    const settledAtMs = Date.now() - 60_000;
    await writeFile(join(root, "skills", "mine", "notes.md"), "edited after the run\n");
    const [row] = await localWork(
      scope(),
      targetTable(),
      emptyLock(),
      new Set(),
      carried("mine", { settledAtMs }),
    );
    expect(row?.state).toBe("edited");
    expect(row?.carriedBy).toBe("job_import");
    expect(row?.detail).toBe("edited since job import-local last ran; [p] runs it now");
  });

  test("says why a carried folder needs attention", async () => {
    await skill("mine");
    const [row] = await localWork(
      scope(),
      targetTable(),
      emptyLock(),
      new Set(),
      carried("mine", { outcome: "attention", detail: "held for review" }),
    );
    expect(row?.state).toBe("imported");
    expect(row?.detail).toBe("carried by job import-local; needs attention: held for review");
  });

  test("matches a carried folder by its real path", async ({ tmp }) => {
    await skill("mine");
    const alias = join(tmp, "root");
    await symlink(root, alias);
    const via: Carried = new Map([
      [
        join(alias, "skills", "mine"),
        {
          job: "import-local",
          jobId: "job_import",
          settledAtMs: undefined,
          outcome: "changed",
          detail: undefined,
        },
      ],
    ]);
    const [row] = await localWork(scope(), targetTable(), emptyLock(), new Set(), via);
    expect(row?.state).toBe("imported");
  });

  test("still lets the lock win over a job that carries the folder", async () => {
    await skill("mine");
    const [row] = await localWork(
      scope(),
      targetTable(),
      locked("mine"),
      new Set(),
      carried("mine"),
    );
    expect(row?.state).toBe("duplicate");
  });

  test("leaves a folder no job carries as never sent", async () => {
    await skill("mine");
    await skill("other");
    const rows = await localWork(scope(), targetTable(), emptyLock(), new Set(), carried("mine"));
    expect(rows.map((row) => [row.name, row.state])).toEqual([
      ["mine", "imported"],
      ["other", "unpublished"],
    ]);
  });
});
