import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { PublishInput } from "#adapter/index.ts";
import { roots as makeRoots } from "#core/store/paths.ts";
import { test } from "#test/kit/fixtures.ts";
import { artifactKey } from "./decide.ts";
import { mutateRemote } from "./remote.ts";
import type { Scan } from "./scan.ts";

const offered = vi.hoisted(() => [] as PublishInput[]);

vi.mock("#accounts/registry.ts", () => ({
  readRootManifest: async () => ({ registries: { acme: { location: "https://acme.example" } } }),
  resolveRegistry: async () => ({
    location: "https://acme.example",
    source: { location: "https://acme.example" },
  }),
}));
vi.mock("#accounts/credentials.ts", () => ({ credentialFor: async () => undefined }));
vi.mock("#core/adapter/source.ts", () => ({
  connectSource: async () => ({
    adapter: { id: "acme", displayName: "Acme" },
    handle: {
      publish: async (changes: readonly PublishInput[]) => {
        offered.push(...changes);
        return {};
      },
      close: async () => {},
    },
  }),
}));

test("offers new local work in the namespace the account publishes into", async ({ tmp }) => {
  const from = join(tmp, "hello");
  await mkdir(from, { recursive: true });
  await writeFile(join(from, "SKILL.md"), "---\nname: hello\ndescription: Says hello.\n---\n");
  const scan = {
    items: [],
    local: [{ name: "hello", kind: "skill", from }],
    pinned: { registries: {}, artifacts: {} },
  } as unknown as Scan;

  await mutateRemote(
    scan,
    { scope: "project", cwd: tmp },
    { config: {} } as never,
    { id: "acc_1", registry: "acme", defaultNamespace: "engineering" },
    new Map([["skill:hello", "publish"]]),
    new AbortController().signal,
    { event: () => {} },
  );

  expect(offered.map(({ name, namespace }) => ({ name, namespace }))).toEqual([
    { name: "hello", namespace: "engineering" },
  ]);
});

test("fails only the installed copy reached through a symlinked namespace folder", async ({
  tmp,
}) => {
  offered.length = 0;
  const roots = makeRoots("project", join(tmp, "project"));
  const skill = "---\nname: lint\ndescription: L.\n---\n";
  await mkdir(join(roots.artifacts, "acme", "ops", "skills", "deploy"), { recursive: true });
  await writeFile(join(roots.artifacts, "acme", "ops", "skills", "deploy", "SKILL.md"), skill);
  await mkdir(join(tmp, "outside", "skills", "lint"), { recursive: true });
  await writeFile(join(tmp, "outside", "skills", "lint", "SKILL.md"), skill);
  await symlink(join(tmp, "outside"), join(roots.artifacts, "acme", "eng"));
  const row = (name: string, namespace: string) => ({
    registry: "acme",
    namespace,
    name,
    id: `skill_${name}`,
    version: "1.0.0",
  });
  const scan = {
    items: [
      { name: "lint", kind: "skill" },
      { name: "deploy", kind: "skill" },
    ],
    roots,
    local: [],
    acquired: [],
    pinned: {
      registries: {},
      artifacts: { lint: row("lint", "eng"), deploy: row("deploy", "ops") },
    },
  } as unknown as Scan;
  const failed: string[] = [];

  const sent = mutateRemote(
    scan,
    { scope: "project", cwd: roots.cwd },
    { config: {} } as never,
    { id: "acc_1", registry: "acme" },
    new Map([
      [artifactKey("skill", "lint"), "publish"],
      [artifactKey("skill", "deploy"), "publish"],
    ]),
    new AbortController().signal,
    { event: () => {}, failed: (name) => failed.push(name) },
  );

  await expect(sent).rejects.toThrow(/lint was not published because .* is a symlink/);
  expect(offered.map(({ name }) => name)).toEqual(["deploy"]);
  expect(failed).toEqual(["lint"]);
});
