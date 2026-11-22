import { spawnSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect } from "vitest";
import type { CommandContext } from "#cli/commands/command.ts";
import { openInstance } from "#cli/ui/instance.ts";
import { acquire } from "#core/lease/lease.ts";
import { UI_DEFAULT_PORT, UI_RUNTIME_DIR } from "#core/product.ts";
import { roots, toolHome } from "#core/store/paths.ts";
import { homeTest as test } from "#test/kit/fixtures.ts";

const options = (cwd: string) => ({ context: { cwd } as CommandContext, assets: {} });

async function runtimeFiles(): Promise<string[]> {
  const folder = join(toolHome(), UI_RUNTIME_DIR);
  return (await readdir(folder).catch(() => []))
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(folder, name));
}

test("simultaneous launches share one server and only its owner closes it", async ({ project }) => {
  const instances = await Promise.all([
    openInstance(options(project)),
    openInstance(options(project)),
  ]);
  try {
    expect(instances[0]?.port).toBe(instances[1]?.port);
    // Compare as a boolean so an assertion failure cannot print launch credentials.
    expect(instances[0]?.url === instances[1]?.url).toBe(true);
    expect(instances.filter((instance) => instance.close !== undefined)).toHaveLength(1);
    const reopened = await openInstance(options(project));
    expect(reopened.close).toBeUndefined();
    await expect(
      openInstance({ ...options(project), port: reopened.port === 65535 ? 65534 : 65535 }),
    ).rejects.toThrow("already running");
  } finally {
    await Promise.all(instances.map((instance) => instance.close?.()));
  }
  expect(await runtimeFiles()).toEqual([]);
  const restarted = await openInstance(options(project));
  expect(restarted.close).toBeDefined();
  await restarted.close?.();
});

test("keys its runtime file by the folder it serves", async ({ project, tmp }) => {
  const first = await openInstance(options(project));
  const second = await openInstance(options(tmp));
  try {
    expect(second.close).toBeDefined();
    expect(second.port).not.toBe(first.port);
    const files = await runtimeFiles();
    expect(files).toHaveLength(2);
    for (const file of files) {
      const read = JSON.parse(await readFile(file, "utf8"));
      expect(Object.keys(read).sort()).toEqual(["pid", "port", "token"]);
    }
  } finally {
    await first.close?.();
    await second.close?.();
  }
});

test.skipIf(process.platform === "win32")(
  "keeps its runtime file to you alone",
  async ({ project }) => {
    const instance = await openInstance(options(project));
    try {
      const [file] = await runtimeFiles();
      expect((await stat(file ?? "")).mode & 0o777).toBe(0o600);
      expect((await stat(join(toolHome(), UI_RUNTIME_DIR))).mode & 0o777).toBe(0o700);
    } finally {
      await instance.close?.();
    }
  },
);

test("replaces a runtime file whose server is gone", async ({ project }) => {
  const first = await openInstance(options(project));
  const [file] = await runtimeFiles();
  const left = await readFile(file ?? "", "utf8");
  await first.close?.();
  // A crash leaves the file behind; its port no longer answers with that token.
  await writeFile(file ?? "", left, { mode: 0o600 });
  const fresh = await openInstance(options(project));
  try {
    expect(fresh.close).toBeDefined();
    expect(fresh.url.endsWith(JSON.parse(left).token)).toBe(false);
  } finally {
    await fresh.close?.();
  }
});

test("an occupied default port falls back and the fallback is reused", async ({ project }) => {
  const blocker = createServer();
  const ownsPort = await new Promise<boolean>((resolve, reject) => {
    blocker.once("error", (error: NodeJS.ErrnoException) =>
      error.code === "EADDRINUSE" ? resolve(false) : reject(error),
    );
    blocker.listen(UI_DEFAULT_PORT, "127.0.0.1", () => resolve(true));
  });
  try {
    const instance = await openInstance(options(project));
    try {
      expect(instance.port).not.toBe(UI_DEFAULT_PORT);
      expect((await openInstance(options(project))).port).toBe(instance.port);
    } finally {
      await instance.close?.();
    }
    await expect(openInstance({ ...options(project), port: UI_DEFAULT_PORT })).rejects.toThrow();
  } finally {
    if (ownsPort) await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test("starts while an install holds your user scope's lease", async ({ project }) => {
  const lease = await acquire(roots("user", project));
  try {
    const instance = await openInstance(options(project));
    expect(instance.close).toBeDefined();
    await instance.close?.();
  } finally {
    await lease.release();
  }
});

test("takes over a discovery lock its holder left behind", async ({ project }) => {
  const first = await openInstance(options(project));
  const [file] = await runtimeFiles();
  await first.close?.();
  // A pid that has exited, as a launch killed while it held the lock leaves.
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  await writeFile(`${file}.lock`, `${gone} left-behind`, { mode: 0o600 });
  const instance = await openInstance(options(project));
  try {
    expect(instance.close).toBeDefined();
  } finally {
    await instance.close?.();
  }
  expect(
    (await readdir(join(toolHome(), UI_RUNTIME_DIR))).filter((n) => n.includes(".lock")),
  ).toEqual([]);
});
