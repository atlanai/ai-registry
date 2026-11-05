import { chmod, mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { privateDirectory, rpcEndpoint } from "./endpoint.ts";

const home = { AIREG_HOME: "/nonexistent/aireg-endpoint-test" };
// Short, unlike every other test's `aireg-` folder: macOS caps a socket path at 103 bytes.
const PREFIX = "rt-";

describe.skipIf(process.platform === "win32")("rpcEndpoint", () => {
  test("keeps the socket out of a directory other users can write to", async () => {
    const shared = await mkdtemp(join(tmpdir(), PREFIX));
    await chmod(shared, 0o1777);
    const endpoint = rpcEndpoint({ ...home, XDG_RUNTIME_DIR: shared });
    expect(dirname(dirname(endpoint))).toBe(shared);

    const own = await mkdtemp(join(tmpdir(), PREFIX));
    expect(dirname(rpcEndpoint({ ...home, XDG_RUNTIME_DIR: own }))).toBe(own);
  });

  test("finds a shorter directory when the runtime one would not fit a socket path", async () => {
    const deep = join(await mkdtemp(join(tmpdir(), PREFIX)), "d".repeat(120));
    await mkdir(deep, { mode: 0o700 });
    const endpoint = rpcEndpoint({ ...home, XDG_RUNTIME_DIR: deep });
    expect(Buffer.byteLength(endpoint)).toBeLessThan(104);
  });

  test("passes over a socket folder others can enter", async () => {
    const shared = await mkdtemp(join(tmpdir(), PREFIX));
    await chmod(shared, 0o1777);
    const taken = join(shared, `aireg-${process.getuid?.()}`);
    await mkdir(taken, { mode: 0o755 });
    await chmod(taken, 0o755);
    const endpoint = rpcEndpoint({ ...home, XDG_RUNTIME_DIR: shared });
    expect(endpoint.startsWith(taken)).toBe(false);
  });
});

describe("rpcEndpoint on Windows", () => {
  const PIPE = /^\\\\\.\\pipe\\aireg-[0-9a-f]{16}-([0-9a-f]{32})$/;

  test("names the pipe with a secret kept in the home, the same on every call", async () => {
    const env = { AIREG_HOME: await mkdtemp(join(tmpdir(), PREFIX)) };
    const name = rpcEndpoint(env, "win32");
    const secret = PIPE.exec(name)?.[1];
    expect(secret).toBeDefined();
    expect(rpcEndpoint(env, "win32")).toBe(name);
    const file = join(env.AIREG_HOME, "state", "pipe-name");
    expect((await readFile(file, "utf8")).trim()).toBe(secret);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("gives every home a pipe of its own", async () => {
    const one = rpcEndpoint({ AIREG_HOME: await mkdtemp(join(tmpdir(), PREFIX)) }, "win32");
    const two = rpcEndpoint({ AIREG_HOME: await mkdtemp(join(tmpdir(), PREFIX)) }, "win32");
    expect(one).not.toBe(two);
  });
});

describe.skipIf(process.platform === "win32")("privateDirectory", () => {
  test("creates the directory for this user alone, and refuses one others can enter", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), PREFIX)), "aireg");
    await privateDirectory(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);

    await chmod(dir, 0o755);
    await expect(privateDirectory(dir)).rejects.toThrow(dir);
  });
});
