import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { shimPath } from "#core/release/layout.ts";
import { test as base } from "#test/kit/fixtures.ts";
import { addToPath, isOurs, onPathIn, removeFromPath } from "./shell-path.ts";

/**
 * A home of startup files, with aireg's folder in its default place. The kit
 * home matters: the default folder is found through os.homedir(), not env.HOME.
 */
const test = base.extend("shell", ({ home }) => {
  const tmp = home.dir;
  const env = (shell: string, more: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    HOME: tmp,
    SHELL: `/bin/${shell}`,
    PATH: "/usr/bin:/bin",
    ...more,
  });
  const read = (name: string) => readFile(join(tmp, name), "utf8");
  return { dir: tmp, env, read, line: '. "$HOME/.aireg/env"' };
});

// Shell startup files are the macOS and Linux mechanism; windows-path.test.ts covers Windows.
const unix = describe.skipIf(process.platform === "win32");

unix("addToPath", () => {
  test("sources the env file from .profile once, keeping what was there", async ({ shell }) => {
    await writeFile(join(shell.dir, ".profile"), "export EDITOR=vi");
    const env = shell.env("sh");

    expect((await addToPath(env)).added).toEqual([join(shell.dir, ".profile")]);
    expect(await addToPath(env)).toEqual({ added: [], failed: [] });

    expect(await shell.read(".profile")).toBe(`export EDITOR=vi\n${shell.line}\n`);
    const sourced = await shell.read(".aireg/env");
    expect(sourced).toContain('*) export PATH="$HOME/.aireg/bin:$PATH" ;;');
    expect(sourced).not.toContain("export AIREG_HOME");
  });

  test("writes a bash file only when it exists", async ({ shell }) => {
    await writeFile(join(shell.dir, ".bashrc"), "alias ll='ls -l'\n");

    const change = await addToPath(shell.env("bash"));

    expect(change.added.sort()).toEqual([join(shell.dir, ".bashrc"), join(shell.dir, ".profile")]);
    expect(existsSync(join(shell.dir, ".bash_profile"))).toBe(false);
    expect(await shell.read(".bashrc")).toBe(`alias ll='ls -l'\n${shell.line}\n`);
  });

  // An agent's `zsh -c` reads .zshenv but not .zshrc.
  test("writes .zshenv for zsh, in ZDOTDIR as well when one is set", async ({ shell }) => {
    const zdot = join(shell.dir, "zsh");
    await mkdir(zdot);

    const change = await addToPath(shell.env("zsh", { ZDOTDIR: zdot }));

    expect(change.added).toEqual(
      expect.arrayContaining([join(shell.dir, ".zshenv"), join(zdot, ".zshenv")]),
    );
    expect(await shell.read(".zshenv")).toBe(`${shell.line}\n`);
  });

  test("gives fish a file of its own, written once", async ({ shell }) => {
    const env = shell.env("fish");
    const fish = join(shell.dir, ".config", "fish", "conf.d", "aireg.fish");

    expect((await addToPath(env)).added).toContain(fish);
    expect((await addToPath(env)).added).not.toContain(fish);
    expect(await readFile(fish, "utf8")).toContain("set -gx PATH");
  });

  test("exports a moved aireg folder, and refuses one a startup file cannot quote", async ({
    shell,
  }) => {
    const moved = shell.env("sh", { AIREG_HOME: join(shell.dir, "tools", "aireg") });
    await addToPath(moved);
    expect(await shell.read(join("tools", "aireg", "env"))).toContain(
      'export AIREG_HOME="$HOME/tools/aireg"',
    );

    const quoted = shell.env("sh", { AIREG_HOME: join(shell.dir, 'it"s') });
    await expect(addToPath(quoted)).rejects.toThrow(/cannot be written into a shell startup file/);
  });
});

unix("onPathIn and removeFromPath", () => {
  test("find every file the line went into, and take out only that line", async ({ shell }) => {
    await writeFile(join(shell.dir, ".profile"), "export EDITOR=vi\n");
    await writeFile(join(shell.dir, ".bashrc"), "alias ll='ls -l'\n");
    const env = shell.env("fish");
    await addToPath(env);
    const fish = join(shell.dir, ".config", "fish", "conf.d", "aireg.fish");

    expect((await onPathIn(env)).sort()).toEqual(
      [join(shell.dir, ".bashrc"), join(shell.dir, ".profile"), fish].sort(),
    );

    const removal = await removeFromPath(env);
    expect(removal.failed).toEqual([]);
    expect(await onPathIn(env)).toEqual([]);
    expect(await shell.read(".profile")).toBe("export EDITOR=vi\n");
    expect(await shell.read(".bashrc")).toBe("alias ll='ls -l'\n");
    expect(existsSync(fish)).toBe(false);
  });
});

describe("isOurs", () => {
  test("is true only for the shim aireg installed", ({ shell }) => {
    const env = shell.env("sh");
    expect(isOurs(shimPath(env), env)).toBe(true);
    expect(isOurs("/usr/local/bin/aireg", env)).toBe(false);
    expect(isOurs(undefined, env)).toBe(false);
  });
});
