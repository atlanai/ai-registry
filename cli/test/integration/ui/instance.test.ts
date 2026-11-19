import { createHash } from "node:crypto";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type { CommandContext } from "#cli/commands/command.ts";
import { openInstance } from "#cli/ui/instance.ts";
import { UI_DEFAULT_PORT, UI_RUNTIME_PREFIX, UI_SOCKET_FILE } from "#core/product.ts";
import { toolHome } from "#core/store/paths.ts";
import { homeTest as test } from "#test/kit/fixtures.ts";

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

test("an unauthenticated rendezvous client receives no browser credential", async ({ project }) => {
  const instance = await openInstance(options(project));
  try {
    const identity = createHash("sha256").update(toolHome()).digest("hex").slice(0, 24);
    const path =
      process.platform === "win32"
        ? `\\\\.\\pipe\\${UI_RUNTIME_PREFIX}-${identity}`
        : join(tmpdir(), `${UI_RUNTIME_PREFIX}-${process.getuid?.()}-${identity}`, UI_SOCKET_FILE);
    const received = await new Promise<string>((resolve, reject) => {
      const socket = connect(path);
      let text = "";
      socket.on("error", reject);
      socket.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        socket.write(`${"0".repeat(64)}\n`);
      });
      socket.on("close", () => resolve(text));
    });
    expect(/^[a-f0-9]{64}\n$/.test(received)).toBe(true);
  } finally {
    await instance.close?.();
  }
});
