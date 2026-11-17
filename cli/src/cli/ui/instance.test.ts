import { createServer } from "node:net";
import { expect } from "vitest";
import type { CommandContext } from "#cli/commands/command.ts";
import { UI_DEFAULT_PORT } from "#core/product.ts";
import { homeTest as test } from "#test/kit/fixtures.ts";
import { openInstance } from "./instance.ts";

const options = (cwd: string) => ({ context: { cwd } as CommandContext, assets: {} });

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
    expect(reopened.port).toBe(instances[0]?.port);
    await expect(
      openInstance({ ...options(project), port: reopened.port === 65535 ? 65534 : 65535 }),
    ).rejects.toThrow("already running");
  } finally {
    await Promise.all(instances.map((instance) => instance.close?.()));
  }
  const restarted = await openInstance(options(project));
  await restarted.close?.();
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
