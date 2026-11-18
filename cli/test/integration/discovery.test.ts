import { cp, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { registerBuiltinAdapters } from "#adapters/index.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { discoveryCatalog } from "#cli/discovery/catalog.ts";
import { Printer } from "#core/term/printer.ts";
import { SqliteRunStore } from "#daemon/runs/store.ts";
import { homeTest as test } from "#test/kit/fixtures.ts";

const example = fileURLToPath(new URL("../../../examples/acme-registry", import.meta.url));
function context(cwd: string): CommandContext {
  return {
    cwd,
    argv: [],
    printer: new Printer(),
    host: {
      version: "0.0.0",
      connectAccount: async () => {
        throw new Error("Unexpected login");
      },
      openRunStore: () => SqliteRunStore.open(":memory:"),
    },
  };
}

test("local discovery ignores unavailable unselected registries and resolves only one local skill", async ({
  home,
  project,
  tmp,
  aireg,
}) => {
  const registry = join(tmp, "registry");
  await cp(example, registry, { recursive: true });
  expect((await aireg(["registry", "add", registry, "--as", "example", "-g"])).code).toBe(0);
  await rename(registry, `${registry}-offline`);
  const folder = join(home.dir, ".claude", "skills", "recap");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "SKILL.md"),
    "---\nname: recap\ndescription: Summarize notes.\n---\nInstructions.",
  );
  registerBuiltinAdapters();
  const catalog = discoveryCatalog(context(project));
  expect(await catalog.available()).toEqual(["example", "this machine"]);
  const skills = await catalog.list(["this machine"]);
  expect(skills).toHaveLength(1);
  const skill = skills[0];
  expect(skill).toBeDefined();
  if (!skill) throw new Error("Expected skill");
  expect(await catalog.resolve(skill)).toEqual(skill);
  await writeFile(join(folder, "helper.md"), "New supporting instructions.");
  expect((await catalog.resolve(skill))?.digest).not.toBe(skill.digest);
  await rename(folder, `${folder}-gone`);
  expect(await catalog.resolve(skill)).toBeUndefined();
});

test("registry discovery preserves published identities and verifies their digest without local installation", async ({
  project,
  aireg,
}) => {
  expect((await aireg(["registry", "add", example, "--as", "example", "-g"])).code).toBe(0);
  registerBuiltinAdapters();
  const catalog = discoveryCatalog(context(project));
  const skills = await catalog.list(["example"]);
  const skill = skills.find((s) => s.name === "pr-review");
  expect(skill).toMatchObject({ registry: "example", namespace: "engineering", version: "1.2.0" });
  if (!skill) throw new Error("Expected published skill");
  expect(skill.digest).toMatch(/^sha256:/);
  expect(await catalog.resolve(skill)).toEqual(skill);
  expect((await aireg(["registry", "remove", "example", "-g"])).code).toBe(0);
  await expect(catalog.resolve(skill)).rejects.toThrow("no longer configured");
});
