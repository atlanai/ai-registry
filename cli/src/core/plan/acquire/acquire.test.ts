import { afterEach, describe, expect, vi } from "vitest";
import { type Artifact, buildEnvelope } from "#adapter/index.ts";
import { emptyLock, type Lock } from "#core/lock.ts";
import type { Manifest } from "#core/manifest/model.ts";
import { parseManifest } from "#core/manifest/parse.ts";
import { test } from "#test/kit/fixtures.ts";
import { type AcquireOptions, acquire } from "./acquire.ts";
import { answers, lockView } from "./lock-view.ts";
import { newlyYanked } from "./placement.ts";
import { wanted } from "./request.ts";

const fake = vi.hoisted(() => ({
  asked: new Map<string, { want: readonly unknown[]; all: boolean }>(),
  closed: new Set<string>(),
  listed: [] as { path: string; artifact: unknown }[],
}));

vi.mock("#core/adapter/connect.ts", () => ({
  connectSource: async ({ alias }: { alias: string }) => ({
    adapter: { id: "fake", capabilities: {} },
    handle: { alias, close: async () => void fake.closed.add(alias) },
    key: alias,
  }),
  resolveArtifacts: async (
    { handle }: { handle: { alias: string } },
    want: readonly unknown[],
    { all }: { all: boolean },
  ) => {
    if (handle.alias === "broken") throw new Error("cannot list");
    fake.asked.set(handle.alias, { want, all });
    return {
      listed: fake.listed,
      catalog: { entries: [], warnings: [] },
      sourceRevision: undefined,
    };
  },
}));
vi.mock("#core/adapter/materialize.ts", () => ({
  materialize: async (
    _adapter: string,
    _handle: unknown,
    artifact: Artifact,
    options: { onRead?: (bytes: number) => void },
  ) => {
    options.onRead?.(42);
    return { root: "/staged", path: "/staged", envelope: artifact.envelope };
  },
}));

afterEach(() => {
  fake.asked.clear();
  fake.closed.clear();
  fake.listed = [];
  vi.unstubAllEnvs();
});

const manifest = (artifacts: string[]) =>
  parseManifest(
    [
      "registries:",
      "  acme: github.com/acme/registry",
      "artifacts:",
      ...artifacts.map((ref) => `  - ${ref}`),
    ].join("\n"),
  );

/** One locked skill per name, each in the `platform` namespace. */
function locked(versions: Record<string, string>): Lock {
  const lock = emptyLock();
  lock.registries.acme = {
    location: "github.com/acme/registry",
    adapter: "git",
    key: "sha256:acme",
    config: {},
    revision: undefined,
  };
  for (const [name, version] of Object.entries(versions)) {
    lock.artifacts[`platform/${name}`] = {
      registry: "acme",
      id: `artifacts/platform/skill/${name}/${version}`,
      name,
      kind: "skill",
      namespace: "platform",
      address: `artifacts/platform/skill/${name}`,
      content: `sha256:${name}`,
      version,
      path: "",
      digest: "",
      origin: undefined,
      links: [],
    };
  }
  return lock;
}

describe("wanted", () => {
  test("keeps a pin beside a whole namespace from the same registry", () => {
    const request = wanted(manifest(["acme/platform", "acme/platform/skill/lint@1.0.0"]), "acme");
    expect(request).toEqual({
      want: [{ name: "lint", namespace: "platform", kind: "skill", version: "1.0.0" }],
      all: true,
    });
  });

  test("keeps a pin to the one artifact it names where another shares the name", () => {
    const request = wanted(
      manifest(["acme/platform/skill/lint@1.0.0", "acme/data/agent/lint"]),
      "acme",
    );
    expect(request?.want).toEqual([
      { name: "lint", namespace: "data", kind: "agent" },
      { name: "lint", namespace: "platform", kind: "skill", version: "1.0.0" },
    ]);
  });

  test("asks for only the named artifacts when nothing is taken whole", () => {
    const request = wanted(
      manifest(["acme/platform/skill/lint", "acme/data/skill/profile@0.4.0"]),
      "acme",
    );
    expect(request).toEqual({
      want: [
        { name: "profile", namespace: "data", kind: "skill", version: "0.4.0" },
        { name: "lint", namespace: "platform", kind: "skill" },
      ],
      all: false,
    });
  });

  test("asks a marketplace for a plugin by name, since its parts come with it", () => {
    const plugins = parseManifest(
      "registries:\n  acme: { source: github.com/acme/plugins, layout: marketplace }\nartifacts:\n  - acme/docs-kit\n",
    );
    expect(wanted(plugins, "acme")).toEqual({
      want: [{ name: "docs-kit", kind: "plugin" }],
      all: false,
    });
  });

  test("is undefined for a registry the manifest takes nothing from", () => {
    expect(wanted(manifest(["acme/platform"]), "other")).toBeUndefined();
  });
});

describe("acquire, held to the lock", () => {
  const exact = (name: string, version?: string) => ({
    name,
    namespace: "platform",
    kind: "skill",
    ...(version === undefined ? {} : { version }),
  });

  /** What `acquire` asks the registry for, holding each request to `lock`. */
  async function requested(
    asked: Manifest,
    lock: Lock,
    moving: ReadonlySet<string> = new Set(),
    held = false,
  ): Promise<{ want: readonly unknown[]; all: boolean } | undefined> {
    const options: AcquireOptions = { base: "/work", locked: { lock, moving, held } };
    await acquire(asked, options);
    return fake.asked.get("acme");
  }

  test("asks for what the lock holds at the version it holds", async () => {
    const request = await requested(
      manifest(["acme/platform/skill/lint"]),
      locked({ lint: "1.0.0" }),
    );
    expect(request?.want).toContainEqual(exact("lint", "1.0.0"));
  });

  test("takes a whole namespace the lock settles as its rows, so a new artifact waits for update", async () => {
    const lock = locked({ lint: "1.0.0", test: "2.0.0" });
    expect(await requested(manifest(["acme/platform"]), lock)).toEqual({
      want: [exact("lint", "1.0.0"), exact("test", "2.0.0")],
      all: false,
    });
  });

  test("moves a marketplace plugin by name, never by reading the whole marketplace", async () => {
    const lock = locked({});
    lock.registries.acme = {
      ...(lock.registries.acme as Lock["registries"][string]),
      config: { layout: "marketplace" },
    };
    lock.artifacts["docs-kit"] = {
      ...(locked({ x: "1.0.0" }).artifacts["platform/x"] as Lock["artifacts"][string]),
      id: "plugins/docs-kit",
      name: "docs-kit",
      kind: "plugin",
      namespace: undefined,
    };
    const plugins = parseManifest(
      "registries:\n  acme: { source: github.com/acme/registry, layout: marketplace }\nartifacts:\n  - acme/docs-kit\n",
    );
    const request = await requested(plugins, lock, new Set(["docs-kit"]));
    expect(request).toEqual({ want: [{ name: "docs-kit", kind: "plugin" }], all: false });
  });

  test("asks again for the rows a run moves, and for the whole namespace once all of it moves", async () => {
    const lock = locked({ lint: "1.0.0", test: "2.0.0" });
    const one = await requested(manifest(["acme/platform"]), lock, new Set(["platform/lint"]));
    expect(one).toEqual({ want: [exact("lint"), exact("test", "2.0.0")], all: false });
    const both = new Set(["platform/lint", "platform/test"]);
    expect((await requested(manifest(["acme/platform"]), lock, both))?.all).toBe(true);
  });

  test("asks for nothing new for a namespace every row of which was excluded, when held", async () => {
    const lock = locked({ lint: "1.0.0" });
    const emptied = parseManifest(
      [
        "registries:",
        "  acme: github.com/acme/registry",
        "artifacts:",
        "  - ref: acme/platform",
        "    exclude: [skill/lint]",
      ].join("\n"),
    );
    expect((await requested(emptied, lock))?.all).toBe(true);
    expect(await requested(emptied, lock, new Set(), true)).toEqual({ want: [], all: false });
    const source = lockView(lock).source("acme");
    if (source === undefined) throw new Error("no locked source");
    expect(answers(emptied, source)).toBe(false);
    expect(answers(emptied, source, true)).toBe(true);
  });

  test("lets a version the manifest pins win over the lock's", async () => {
    const request = await requested(
      manifest(["acme/platform/skill/lint@2.0.0"]),
      locked({ lint: "1.0.0" }),
    );
    expect(request?.want).toContainEqual(exact("lint", "2.0.0"));
    expect(request?.want).not.toContainEqual(exact("lint", "1.0.0"));
  });
});

describe("answers", () => {
  test("answers from the lock only while the manifest declares the registry it was read from", () => {
    const source = lockView(locked({ lint: "1.0.0" })).source("acme");
    if (source === undefined) throw new Error("no locked source");
    expect(answers(manifest(["acme/platform/skill/lint"]), source)).toBe(true);
    expect(answers(manifest(["acme/platform/skill/lint@2.0.0"]), source)).toBe(false);
    expect(answers(manifest(["acme/platform/skill/test"]), source)).toBe(false);
    const moved = manifest(["acme/platform/skill/lint"]);
    moved.registries.acme = { location: "github.com/acme/other", adapter: undefined, config: {} };
    expect(answers(moved, source)).toBe(false);
  });
});

describe("newlyYanked", () => {
  /** The lock's own view of the registry, with `lint` served at a yanked version. */
  function serving(version: string) {
    const source = lockView(locked({ lint: "1.0.0" })).source("acme");
    if (source === undefined) throw new Error("no source");
    source.placements.set("artifacts/platform/skill/lint", {
      id: `artifacts/platform/skill/lint/${version}`,
      name: "lint",
      contentId: undefined,
      version,
      yanked: { reason: "broke the build" },
    });
    return [source];
  }

  test("lets a yanked version through where the lock already holds it", () => {
    expect(newlyYanked(serving("1.0.0"), locked({ lint: "1.0.0" }))).toEqual([]);
  });

  test("names a yanked version the lock does not hold, and why it was yanked", () => {
    expect(newlyYanked(serving("2.0.0"), locked({ lint: "1.0.0" }))).toEqual([
      '"lint" 2.0.0 is yanked (broke the build)',
    ]);
  });
});

describe("acquire", () => {
  test("closes every registry it opened when one cannot be listed", async ({ tmp }) => {
    const both = parseManifest(
      [
        "registries:",
        "  acme: github.com/acme/registry",
        "  broken: github.com/acme/broken",
        "artifacts:",
        "  - acme",
        "  - broken",
      ].join("\n"),
    );

    await expect(acquire(both, { base: tmp })).rejects.toThrow("cannot list");
    expect([...fake.closed].sort()).toEqual(["acme", "broken"]);
  });

  test("names the artifact whose bytes are downloading, as well as counting them", async ({
    tmp,
  }) => {
    vi.stubEnv("AIREG_HOME", tmp);
    const artifact: Artifact = {
      id: "skills/lint",
      kind: "skill",
      envelope: buildEnvelope({
        kind: "skill",
        metadata: { name: "lint" },
        files: [{ path: "SKILL.md", digest: `sha256:${"0".repeat(64)}`, size: 42 }],
      }),
      files: [{ path: "SKILL.md", locator: "SKILL.md", executable: false }],
    };
    fake.listed = [{ path: "skills/lint", artifact }];
    const onBytes = vi.fn();
    const onDownload = vi.fn();
    const [acme] = await acquire(manifest(["acme/lint"]), { base: tmp, onBytes, onDownload });

    await acme?.content("skills/lint");

    expect(onBytes).toHaveBeenCalledWith(42);
    expect(onDownload).toHaveBeenCalledWith(artifact, 42);
  });
});
