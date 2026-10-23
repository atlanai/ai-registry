import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, vi } from "vitest";
import type { PublishInput } from "#adapter/index.ts";
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

beforeEach(() => {
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
    new Map([["skill:hello", "publish"]]),
    new AbortController().signal,
    { event: () => {} },
  );

  expect(offered.map(({ name, namespace }) => ({ name, namespace }))).toEqual([
    { name: "hello", namespace: "engineering" },
  ]);
});

test("sends only the kind a publish was chosen for, not another of the same name", async ({
  tmp,
}) => {
  const skill = join(tmp, "skills", "lint");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: lint\ndescription: Lints.\n---\n");
  const agent = join(tmp, "agents", "lint.md");
  await mkdir(join(tmp, "agents"), { recursive: true });
  await writeFile(agent, "---\nname: lint\ndescription: Lints too.\n---\n");
  const scan = {
    items: [],
    local: [
      { name: "lint", kind: "agent", from: agent },
      { name: "lint", kind: "skill", from: skill },
    ],
    pinned: { registries: {}, artifacts: {} },
  } as unknown as Scan;

  await mutateRemote(
    scan,
    { scope: "project", cwd: tmp },
    { config: {} } as never,
    { id: "acc_1", registry: "acme", defaultNamespace: "engineering" },
    new Map([["skill:lint", "publish"]]),
    new AbortController().signal,
    { event: () => {} },
  );

  expect(offered.map(({ name, kind }) => ({ name, kind }))).toEqual([
    { name: "lint", kind: "skill" },
  ]);
});
