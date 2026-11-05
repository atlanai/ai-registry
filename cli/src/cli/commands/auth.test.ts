import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, vi } from "vitest";
import { registerBuiltinAdapters } from "#adapters/index.ts";
import { emptyRegistryConfig } from "#core/config/model.ts";
import { writeConfig } from "#core/config/repository.ts";
import { ErrorCode } from "#core/errors.ts";
import { Printer } from "#core/term/printer.ts";
import { ADAPTER, ENDPOINT } from "#test/kit/daemon.ts";
import { test } from "#test/kit/fixtures.ts";
import { run } from "./auth.ts";
import type { CommandContext } from "./command.ts";

let scratch: string;
test.beforeEach(({ tmp }) => {
  scratch = tmp;
});

function context(argv: string[], cwd = tmpdir()): CommandContext {
  return {
    argv,
    cwd,
    printer: new Printer({ format: "json", out: { write: () => {}, isTTY: false } }),
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

describe("auth list", () => {
  beforeAll(() => registerBuiltinAdapters());
  afterEach(() => vi.unstubAllEnvs());

  test("says a registry that needs no sign-in needs none, not that you are signed out", async () => {
    const home = join(scratch, "home");
    await mkdir(join(home, "acme"), { recursive: true });
    await writeFile(
      join(home, "manifest.yml"),
      [
        "registries:",
        `  acme: ${join(home, "acme")}`,
        `  cloud:`,
        `    source: ${ENDPOINT}/team`,
        "    adapter: dev",
        "",
      ].join("\n"),
    );
    vi.stubEnv("AIREG_HOME", join(home, ".aireg"));
    vi.stubEnv("AIREG_USER_SCOPE", home);
    const accounts = [
      { id: "acc_1", registry: "acme" },
      { id: "acc_2", registry: "cloud" },
    ];
    await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER }, accounts }, 0);
    const printed: string[] = [];
    const listing = context(["list"]);
    listing.printer = new Printer({
      format: "json",
      out: { write: (text: string) => printed.push(text) && true, isTTY: false },
    });

    await run(listing);

    expect(JSON.parse(printed.join("")).data.accounts).toEqual([
      { id: "acc_1", registry: "acme", signedIn: false, needsSignIn: false },
      { id: "acc_2", registry: "cloud", signedIn: false, needsSignIn: true },
    ]);
  });
});

describe("auth login", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("refuses to store a token while AIREG_TOKEN_<NAME> is set", async () => {
    vi.stubEnv("AIREG_TOKEN_ACME", "synthetic-token");
    vi.stubEnv("AIREG_HOME", "/nonexistent/aireg-home-never-created");
    vi.stubEnv("AIREG_USER_SCOPE", "/nonexistent/registry-home-never-created");
    for (const argv of [
      ["login", "acme"],
      ["login", "acme", "--token-stdin"],
    ]) {
      await expect(run(context(argv))).rejects.toMatchObject({
        code: ErrorCode.Conflict,
        message: "AIREG_TOKEN_ACME is set, so aireg already uses it for acme.",
        hint:
          "Nothing was stored, since commands here would go on using AIREG_TOKEN_ACME. " +
          "To store a sign-in, which background jobs need, unset it and run this again.",
      });
    }
  });

  test("refuses --token-stdin on a terminal, where the token would echo", async () => {
    vi.stubEnv("AIREG_HOME", "/nonexistent/aireg-home-never-created");
    vi.stubEnv("AIREG_USER_SCOPE", "/nonexistent/registry-home-never-created");
    const tty = (value: boolean | undefined) =>
      Object.defineProperty(process.stdin, "isTTY", { value, configurable: true, writable: true });
    const was = process.stdin.isTTY;
    tty(true);
    try {
      await expect(
        run(context(["login", "acme", "--address", ENDPOINT, "--token-stdin"])),
      ).rejects.toMatchObject({
        code: ErrorCode.Usage,
        message: "--token-stdin reads a pipe, not the terminal.",
        hint: "Pipe the token in: `… | aireg auth login acme --token-stdin`.",
      });
    } finally {
      tty(was);
    }
  });

  describe("in a project", () => {
    beforeAll(() => registerBuiltinAdapters());

    async function project(registries: string[], user: string[] = []): Promise<string> {
      const root = await mkdtemp(join(scratch, "aireg-auth-project-"));
      const home = join(root, "home");
      await mkdir(join(root, ".registry"), { recursive: true });
      await mkdir(home, { recursive: true });
      await writeFile(
        join(root, ".registry", "manifest.yml"),
        ["registries:", ...registries, ""].join("\n"),
      );
      await writeFile(join(home, "manifest.yml"), ["registries:", ...user, ""].join("\n"));
      vi.stubEnv("AIREG_HOME", join(home, ".aireg"));
      vi.stubEnv("AIREG_USER_SCOPE", home);
      return root;
    }

    test("finds the project's registry, and says a folder needs no sign-in", async () => {
      const root = await project(["  acme: ./registry"]);
      await mkdir(join(root, "registry"));
      await expect(run(context(["login", "acme"], root))).rejects.toMatchObject({
        code: ErrorCode.Usage,
        message: "acme needs no sign-in, so there is nothing to log in to.",
      });
    });

    test("says a git registry is read with your own credentials, as its hint goes on to say", async () => {
      const root = await project(["  acme: github.com/acme/ai-registry"]);
      await expect(run(context(["login", "acme"], root))).rejects.toMatchObject({
        code: ErrorCode.Usage,
        message: "aireg keeps no sign-in for acme, which is read with your own credentials.",
        hint: expect.stringContaining("gh auth login"),
      });
    });

    test("names the address only a project declares before signing in to it", async () => {
      const root = await project(["  acme:", `    source: ${ENDPOINT}/team`, "    adapter: dev"]);
      await writeConfig({ ...emptyRegistryConfig(), adapters: { dev: ADAPTER } }, 0);
      await expect(run(context(["login", "acme"], root))).rejects.toMatchObject({
        code: ErrorCode.Usage,
        message: `Only this project declares acme, at ${ENDPOINT}/team.`,
        hint: `To sign in there, pass \`--yes\` or name it: \`aireg auth login acme --address ${ENDPOINT}/team\`.`,
      });
    });

    test("refuses an alias the project and the user scope point at different addresses", async () => {
      const root = await project(
        ["  acme: https://one.example.test/org"],
        ["  acme: https://two.example.test/org"],
      );
      await expect(run(context(["login", "acme"], root))).rejects.toMatchObject({
        code: ErrorCode.Usage,
        message: expect.stringContaining("in your user scope"),
      });
    });

    test("refuses an --address your user scope declares elsewhere, before any sign-in", async () => {
      const root = await project([], ["  acme: https://two.example.test/org"]);
      const argv = ["login", "acme", "--address", "https://one.example.test/org"];
      await expect(run(context(argv, root))).rejects.toMatchObject({
        code: ErrorCode.Usage,
        message:
          "acme is https://two.example.test/org in your user scope, not https://one.example.test/org.",
      });
    });
  });
});
