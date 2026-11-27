import { existsSync, lstatSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test as base } from "#test/kit/fixtures.ts";

/** Serves the namespace `team` as `members.json` says, read afresh each time; `g2` is gamma 1.0.2. */
const ADAPTER = `import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const members = () => JSON.parse(readFileSync(new URL("./members.json", import.meta.url), "utf8"));
const body = (name) => \`---\\nname: \${name}\\ndescription: \${name}.\\n---\\n\${members()[name]}\\n\`;
export default {
  id: "team", displayName: "team", protocol: 1, artifactKinds: ["skill"],
  dispatch: { hosts: ["team.example"] },
  capabilities: { pinsSource: false, namespacePlugins: true },
  connect: async () => ({
    resolve: async () => ({
      complete: true,
      artifacts: Object.keys(members()).map((name) => ({
        id: \`skill_\${name}\`, kind: "skill", group: "team",
        envelope: {
          apiVersion: "aireg.sh/v1", kind: "skill",
          metadata: { name, namespace: "team", version: \`1.0.\${members()[name].slice(1)}\`, description: \`\${name}.\` },
          files: [{ path: "SKILL.md", size: Buffer.byteLength(body(name)), media_type: "text/markdown",
            digest: \`sha256:\${createHash("sha256").update(body(name)).digest("hex")}\`, urls: [name] }],
        },
        files: [{ path: "SKILL.md", locator: name, executable: false }],
      })),
    }),
    fetch: async (_artifact, file) => new TextEncoder().encode(body(file.locator)),
    close: async () => {},
  }),
};
`;

const test = base.extend("team", async ({ home: { dir: home } }) => {
  await mkdir(join(home, ".aireg"), { recursive: true, mode: 0o700 });
  await writeFile(join(home, "team.mjs"), ADAPTER);
  await writeFile(
    join(home, ".aireg", "config.yml"),
    `schemaVersion: 1\nrevision: 0\nadapters:\n  team: ${join(home, "team.mjs")}\naccounts: []\njobs: []\n`,
  );
  return {
    home,
    plugin: join(home, ".cursor", "plugins", "local", "team"),
    serve: (members: Record<string, string>) =>
      writeFile(join(home, "members.json"), JSON.stringify(members)),
  };
});

const skills = async (plugin: string) => (await readdir(join(plugin, "skills"))).sort();
const skill = (plugin: string, name: string) =>
  readFile(join(plugin, "skills", name, "SKILL.md"), "utf8");

describe("a namespace Cursor loads as a copied plugin", () => {
  test("follows its members in place, and backs up a copy someone edited", async ({
    aireg,
    team: { home, plugin, serve },
    tmp,
  }) => {
    const run = async (args: string[]) => {
      const ran = await aireg([...args, "-g", "--yes"], { cwd: tmp });
      expect(ran.code, ran.stderr).toBe(0);
      expect(ran.stderr).not.toContain("already holds something of yours");
      return ran;
    };
    await serve({ alpha: "a1", beta: "b1" });
    await run([
      "add",
      "https://team.example",
      "--adapter",
      "team",
      "--all",
      "--for",
      "cursor",
      "--no-auto-update",
    ]);
    expect(lstatSync(plugin).isSymbolicLink()).toBe(false);
    expect(await skills(plugin)).toEqual(["alpha", "beta"]);
    expect(existsSync(join(plugin, ".cursor-plugin", "plugin.json"))).toBe(true);

    await serve({ alpha: "a1", beta: "b1", gamma: "g1" });
    await run(["update"]);
    expect(await skills(plugin)).toEqual(["alpha", "beta", "gamma"]);
    const lock = await readFile(join(home, ".registry", "manifest.lock.yml"), "utf8");
    expect(lock).not.toContain("blocked");

    await serve({ alpha: "a1", gamma: "g1" });
    await run(["update"]);
    expect(await skills(plugin)).toEqual(["alpha", "gamma"]);

    // Nothing changed, so the copy is left as it is.
    const before = lstatSync(join(plugin, "skills", "alpha", "SKILL.md")).ino;
    await run(["update"]);
    expect(lstatSync(join(plugin, "skills", "alpha", "SKILL.md")).ino).toBe(before);

    await writeFile(join(plugin, "skills", "alpha", "SKILL.md"), "mine\n");
    await serve({ alpha: "a1", gamma: "g2" });
    const ran = await run(["update"]);
    expect(ran.stderr).toMatch(/Moved your folder .*plugins\/local\/team to .*backups/);
    expect(await skill(plugin, "gamma")).toContain("g2");
    expect(await skill(plugin, "alpha")).toContain("a1");
    const [stamp] = await readdir(join(home, ".registry", "backups"));
    const kept = join(home, ".registry", "backups", stamp as string, "cursor", "local", "team");
    expect(await skill(kept, "alpha")).toBe("mine\n");
  });
});
