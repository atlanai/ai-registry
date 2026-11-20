import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { expect } from "vitest";
import { skillsFolder } from "#test/kit/builders/layouts.ts";
import { gitRegistry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";
import { projected } from "#test/kit/target.ts";

/** Run from the home with service managers that know no aireg service, so none is reached. */
async function awayFrom(home: string, tmp: string) {
  const stubs = join(tmp, "service-managers");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(stubs, { recursive: true });
  for (const name of ["launchctl", "systemctl"]) {
    await writeFile(join(stubs, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  return { cwd: home, env: { PATH: `${stubs}:${process.env.PATH}` } };
}

// Startup files and POSIX service managers; on Windows PATH is the user's registry, which CI's
// standalone install covers rather than a test on a developer's machine.
test.skipIf(process.platform === "win32")(
  "self uninstall asks first, then removes the user scope, the PATH line and aireg's folders",
  async ({ aireg, git, home, tmp }) => {
    const repo = await gitRegistry(git, join(tmp, "kit"));
    const away = await awayFrom(home.dir, tmp);
    const added = await aireg(["add", `file://${repo}@v1`, "--select", "lint", "-g"], away);
    expect(added.code, added.stderr).toBe(0);
    await writeFile(join(home.dir, ".profile"), 'export EDITOR=vi\n. "$HOME/.aireg/env"\n');

    const unasked = await aireg(["self", "uninstall"], away);
    expect(unasked.code).toBe(2);
    expect(unasked.stderr).toMatch(/-y/);
    expect(projected(home.dir, "lint")).toBeTruthy();

    const removed = await aireg(["self", "uninstall", "-y"], away);
    expect(removed.code, removed.stderr).toBe(0);
    expect(() => projected(home.dir, "lint")).toThrow();
    expect(existsSync(home.aireg)).toBe(false);
    expect(existsSync(home.scope)).toBe(false);
    expect(await readFile(join(home.dir, ".profile"), "utf8")).toBe("export EDITOR=vi\n");
  },
);

test.skipIf(process.platform === "win32")(
  "self uninstall leaves a folder of yours that replaced a link",
  async ({ aireg, git, home, tmp }) => {
    const repo = await gitRegistry(git, join(tmp, "kit"));
    const away = await awayFrom(home.dir, tmp);
    const added = await aireg(["add", `file://${repo}@v1`, "--select", "lint", "-g"], away);
    expect(added.code, added.stderr).toBe(0);
    const folder = dirname(projected(home.dir, "lint"));
    const mine = "---\nname: lint\ndescription: My own rules.\n---\n";
    await unlink(folder);
    await mkdir(folder);
    await writeFile(join(folder, "SKILL.md"), mine);

    const planned = await aireg(["self", "uninstall", "--dry-run", "--json"], away);
    expect(planned.code, planned.stderr).toBe(0);
    const shown = relative(home.dir, folder);
    const { data } = JSON.parse(planned.stdout);
    expect(data.links.some((path: string) => path.endsWith(shown))).toBe(false);
    expect(data.kept.some((path: string) => path.endsWith(shown))).toBe(true);
    const removed = await aireg(["self", "uninstall", "-y"], away);

    expect(removed.code, removed.stderr).toBe(0);
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe(mine);
    expect(removed.stdout).toContain(`Kept ~/${shown}, since aireg did not put it there.`);
    expect(existsSync(home.scope)).toBe(false);
  },
);

test.skipIf(process.platform === "win32")(
  "self uninstall takes aireg's entries out of a fan-out folder and leaves the files you added",
  async ({ aireg, home, tmp }) => {
    const away = await awayFrom(home.dir, tmp);
    // Codex reads a plugin from a fan-out folder.
    const root = await skillsFolder(join(tmp, "single"))
      .json(".codex-plugin/plugin.json", { name: "hello" })
      .skill("skills/greet")
      .write();
    const added = await aireg(
      ["add", root, "--all", "-g", "--for", "codex", "--no-auto-update"],
      away,
    );
    expect(added.code, added.stderr).toBe(0);
    const fan = join(home.dir, ".codex", "plugins", "cache", "single", "hello", "local");
    await writeFile(join(fan, "notes.md"), "mine\n");

    const planned = await aireg(["self", "uninstall", "--dry-run", "--json"], away);
    expect(planned.code, planned.stderr).toBe(0);
    const { data } = JSON.parse(planned.stdout);
    expect(data.links).toContain(fan);
    expect(data.kept).not.toContain(fan);
    const removed = await aireg(["self", "uninstall", "-y"], away);

    expect(removed.code, removed.stderr).toBe(0);
    expect(await readdir(fan)).toEqual(["notes.md"]);
    expect(removed.stdout).not.toContain("Kept ~/.codex");
    expect(existsSync(home.scope)).toBe(false);
  },
);
