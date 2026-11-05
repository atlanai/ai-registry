import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect } from "vitest";
import { registerBuiltinAdapters } from "#adapters/index.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { PACKAGE } from "#core/product.ts";
import { Printer } from "#core/term/printer.ts";
import { homeTest as test } from "#test/kit/fixtures.ts";
import { tempDir } from "#test/kit/temp.ts";
import { run } from "./adapter.ts";
import type { CommandContext } from "./command.ts";

// Never the checkout: an init that is not refused would write its package here.
let cwd: string;

beforeAll(async () => {
  registerBuiltinAdapters();
  cwd = await tempDir("adapter-command");
});

function context(argv: string[]): CommandContext {
  return {
    argv,
    cwd,
    printer: new Printer({ format: "json", out: { write() {}, isTTY: false } }),
    host: {
      version: "test",
      connectAccount: async () => {
        throw new Error("no host");
      },
      openRunStore: async () => {
        throw new Error("no host");
      },
    },
  };
}

async function runJson(argv: string[], at = cwd): Promise<{ data: unknown }> {
  const writes: string[] = [];
  await run({
    argv,
    cwd: at,
    printer: new Printer({
      format: "json",
      out: { write: (chunk: string) => writes.push(chunk), isTTY: false },
    }),
    host: context(argv).host,
  });
  return JSON.parse(writes.join("")) as { data: unknown };
}

describe("adapter command", () => {
  test("refuses install on an unstamped build", async () => {
    await expect(run(context(["install", "atlan"]))).rejects.toThrow(/no release server/);
  });

  test("asks before installing an adapter it does not trust, and names no trusted one", async () => {
    const refused = await run(context(["install", "acme"])).catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: "usage",
      message: '"acme" is not a trusted adapter.',
      hint: "Pass `--yes` to install an adapter that is not trusted.",
    });
    expect(JSON.stringify(refused)).not.toMatch(/\batlan\b/i);
  });

  test("installs an adapter it does not trust when told to", async () => {
    await expect(run(context(["install", "acme", "--yes"]))).rejects.toThrow(/no release server/);
  });

  test("lists nothing until an origin install lands", async () => {
    const writes: string[] = [];
    const ctx: CommandContext = {
      argv: ["list"],
      cwd,
      printer: new Printer({
        format: "json",
        out: { write: (chunk: string) => writes.push(chunk), isTTY: false },
      }),
      host: context(["list"]).host,
    };
    await run(ctx);
    expect(JSON.parse(writes.join(""))).toEqual({ ok: true, data: { adapters: [] } });
  });

  test("refuses an unknown action", async () => {
    await expect(run(context(["publish", "acme"]))).rejects.toBeInstanceOf(AiregError);
  });

  test("scaffolds a standalone package that builds on the published contract", async ({ tmp }) => {
    const cwd = join(tmp, "acme");
    const payload = await runJson(["init", "acme", "--dir", cwd], cwd);
    const files = (payload.data as { id: string; files: string[] }).files;
    expect((payload.data as { id: string }).id).toBe("acme");
    expect(files).toEqual(
      expect.arrayContaining([
        "package.json",
        "tsconfig.json",
        "README.md",
        "src/index.ts",
        "test/compliance.test.ts",
      ]),
    );
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
      dependencies?: unknown;
      engines: { node: string };
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.engines.node).toBe("^22.23.4 || ^24.22.1 || >=26.12.1");
    expect(pkg.peerDependencies[PACKAGE]).toMatch(/^\^\d+\.\d+$/);
    expect(pkg.devDependencies[PACKAGE]).toBe(pkg.peerDependencies[PACKAGE]);
    expect(await readFile(join(cwd, "src/index.ts"), "utf8")).toContain(`from "${PACKAGE}"`);
    expect(await readFile(join(cwd, "test/compliance.test.ts"), "utf8")).toContain(
      "assertAdapterCompliance",
    );
    expect(await readFile(join(cwd, "README.md"), "utf8")).not.toMatch(/\batlan\b/i);
    for (const file of files) {
      expect(await readFile(join(cwd, file), "utf8")).not.toMatch(/\.\.\/adapter\/|cli\/src/);
    }
  });

  test("refuses to scaffold a built-in adapter", async () => {
    await expect(run(context(["init", "git"]))).rejects.toThrow(/built into aireg/);
  });
});

describe("adapter init writes only inside its folder", () => {
  /** An empty folder outside the one being scaffolded, and where the package goes. */
  async function folders(tmp: string): Promise<{ dir: string; outside: string }> {
    const outside = join(tmp, "outside");
    await mkdir(outside);
    return { dir: join(tmp, "acme"), outside };
  }

  test("refuses with --force a subfolder that is a symlink", async ({ tmp }) => {
    const { dir, outside } = await folders(tmp);
    await mkdir(dir);
    await symlink(outside, join(dir, "src"));
    await expect(runJson(["init", "acme", "--dir", dir, "--force"], tmp)).rejects.toMatchObject({
      code: ErrorCode.Invalid,
    });
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(dir)).toEqual(["src"]);
  });

  test("replaces its own files with --force", async ({ tmp }) => {
    const { dir } = await folders(tmp);
    await mkdir(dir);
    await writeFile(join(dir, "package.json"), "old");
    await runJson(["init", "acme", "--dir", dir, "--force"], tmp);
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8"))).toMatchObject({
      name: expect.stringContaining("acme"),
    });
    expect(await readdir(join(dir, "src"))).toContain("index.ts");
  });
});
