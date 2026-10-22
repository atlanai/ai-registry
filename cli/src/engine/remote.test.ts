import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { PublishInput } from "#adapter/index.ts";
import { roots as makeRoots } from "#core/store/paths.ts";
import { test } from "#test/kit/fixtures.ts";
import { mutateRemote } from "./remote.ts";
import type { Scan } from "./scan.ts";

const offered = vi.hoisted(() => [] as PublishInput[]);

vi.mock("#accounts/service.ts", () => ({
  AccountService: class {
    async resolve() {
      return { location: "https://acme.example", source: { location: "https://acme.example" } };
    }
  },
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
    new Map([["hello", "publish"]]),
    new AbortController().signal,
    { event: () => {} },
  );

  expect(offered.map(({ name, namespace }) => ({ name, namespace }))).toEqual([
    { name: "hello", namespace: "engineering" },
  ]);
});

// A repository ships its .registry folder, so a link there could point an installed copy at your home.
test.for([
  ["a real folder", false],
  ["a symlinked namespace folder", true],
] as const)("publishes an installed copy only through %s", async ([, linked], { tmp }) => {
  offered.length = 0;
  const roots = makeRoots("project", join(tmp, "project"));
  const real = linked ? join(tmp, "outside") : join(roots.artifacts, "acme", "eng");
  await mkdir(join(real, "skills", "lint"), { recursive: true });
  await writeFile(
    join(real, "skills", "lint", "SKILL.md"),
    "---\nname: lint\ndescription: L.\n---\n",
  );
  if (linked) {
    await mkdir(join(roots.artifacts, "acme"), { recursive: true });
    await symlink(real, join(roots.artifacts, "acme", "eng"));
  }
  const scan = {
    items: [{ name: "lint", kind: "skill" }],
    roots,
    local: [],
    pinned: {
      registries: {},
      artifacts: {
        lint: { registry: "acme", namespace: "eng", name: "lint", id: "skill_1", version: "1.0.0" },
      },
    },
  } as unknown as Scan;

  const sent = mutateRemote(
    scan,
    { scope: "project", cwd: roots.cwd },
    { config: {} } as never,
    { id: "acc_1", registry: "acme" },
    new Map([["lint", "publish"]]),
    new AbortController().signal,
    { event: () => {} },
  );

  if (linked) await expect(sent).rejects.toThrow(/lint was not published because .* is a symlink/);
  else await sent;
  expect(offered.map(({ name }) => name)).toEqual(linked ? [] : ["lint"]);
});
