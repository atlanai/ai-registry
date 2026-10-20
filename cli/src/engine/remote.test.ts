import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { PublishInput } from "#adapter/index.ts";
import { artifactPath } from "#core/store/paths.ts";
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

test.beforeEach(() => {
  offered.length = 0;
});

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

test("counts an edit's next version past one the registry holds unlisted, such as a yanked one", async ({
  tmp,
}) => {
  const roots = { artifacts: tmp };
  const path = artifactPath(roots, "acme", "eng", "skill", "lint", "eng/skill/lint");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), "---\nname: lint\ndescription: Lints code.\n---\n");
  const row = {
    registry: "acme",
    id: "lint",
    name: "lint",
    kind: "skill",
    namespace: "eng",
    address: "eng/skill/lint",
    version: "0.1.0",
  };
  const scan = {
    roots,
    items: [{ name: "lint", kind: "skill" }],
    local: [],
    pinned: { registries: {}, artifacts: { lint: row } },
    acquired: [
      {
        alias: "acme",
        placements: new Map([["eng/skill/lint", { version: "0.1.0" }]]),
        catalog: {
          entries: [],
          newest: [{ name: "lint", group: "eng", kind: "skill", version: "0.1.1" }],
        },
      },
    ],
  } as unknown as Scan;

  await mutateRemote(
    scan,
    { scope: "project", cwd: tmp },
    { config: {} } as never,
    { id: "acc_1", registry: "acme", defaultNamespace: "eng" },
    new Map([["lint", "publish"]]),
    new AbortController().signal,
    { event: () => {} },
  );

  expect(offered.map(({ name, version }) => ({ name, version }))).toEqual([
    { name: "lint", version: "0.1.2" },
  ]);
});
