import { describe, expect, it } from "vitest";
import {
  AdapterError,
  type Envelope,
  type RegistryIdentity,
  type SourceAdapter,
} from "#adapter/index.ts";
import { MAX_SOURCE_MANIFEST } from "#adapter/layouts/project.ts";
import { ENVELOPE_API_VERSION } from "#adapter/spec/types.ts";
import { resolveArtifacts } from "./source.ts";

/** Composed by hand, not built: these listings are meant to be malformed. */
function serving(
  files: { path: string; locator?: string }[],
  registry?: RegistryIdentity,
  more: Record<string, unknown> = {},
  kind: "skill" | "agent" = "skill",
): SourceAdapter {
  const envelope: Envelope = {
    apiVersion: ENVELOPE_API_VERSION,
    kind,
    metadata: { name: "lint" },
    files: files.map((file) => ({ path: file.path, digest: `sha256:${"0".repeat(64)}`, size: 0 })),
  };
  return {
    id: "probe",
    displayName: "Probe",
    protocol: 1,
    artifactKinds: [kind],
    dispatch: { schemes: ["probe"] },
    capabilities: { pinsSource: false, publish: false, auth: false },
    connect: async () => ({
      resolve: async () => ({
        artifacts: [
          {
            id: "a1",
            kind,
            envelope,
            files: files.map((file) => ({
              path: file.path,
              locator: file.locator ?? file.path,
              executable: false,
            })),
          },
        ],
        ...(registry === undefined ? {} : { registry }),
        ...more,
      }),
      fetch: async () => new Uint8Array(),
      close: async () => {},
    }),
  };
}

async function resolveWith(adapter: SourceAdapter) {
  const open = {
    adapter,
    handle: await adapter.connect({
      source: { registry: "probe", location: "probe://x", config: {}, key: "sha256:k" },
      credential: undefined,
      signal: new AbortController().signal,
      limits: { timeoutMs: 1000, retries: 0 },
      onBytes: () => {},
      cacheDir: () => "",
      exclusive: (_key, run) => run(),
    }),
    key: "sha256:k",
  };
  return resolveArtifacts(open, []);
}

describe("the identity an adapter reports", () => {
  it("keeps a URL only as the canonical https root an edge names", async () => {
    const at = async (url: string) =>
      (await resolveWith(serving([{ path: "SKILL.md" }], { name: "acme", url }))).registry?.url;
    expect(await at("https://GitHub.com/acme/kit.git/")).toBe("https://github.com/acme/kit");
    expect(await at("http://github.com/acme/kit")).toBeUndefined();
    expect(await at("file:///srv/kit")).toBeUndefined();
  });
});

describe("an agent of many files", () => {
  it("is listed as its AGENT.md, its other files left out of what installs", async () => {
    const files = [{ path: "AGENT.md" }, { path: "workspace/AGENTS.md" }, { path: "a.md" }];
    const listing = await resolveWith(serving(files, undefined, {}, "agent"));
    const [listed] = listing.listed;
    expect(listed?.path).toBe("artifacts/lint/agent/lint.md");
    expect(listed?.artifact.files.map((file) => file.path)).toEqual(["AGENT.md"]);
    expect(listed?.leftOut).toEqual(["a.md", "workspace/AGENTS.md"]);
    // Its envelope still describes every file, so its content identity is the one published.
    expect(listed?.artifact.envelope.files).toHaveLength(3);
    expect(listing.catalog.warnings).toEqual([]);
  });

  it("is dropped, with a warning, when it holds no entry file", async () => {
    const listing = await resolveWith(
      serving([{ path: "one.md" }, { path: "two.md" }], undefined, {}, "agent"),
    );
    expect(listing.listed).toEqual([]);
    expect(listing.catalog.warnings).toEqual([
      '"lint" is an agent, which is one file, but 2 were published and none is its entry file.',
    ]);
  });
});

describe("the project manifest a source holds", () => {
  const serve = async (manifest: unknown) =>
    (await resolveWith(serving([{ path: "SKILL.md" }], undefined, { manifest }))).manifest;
  const artifact = { path: "skills/lint", id: "a1", kind: "skill", name: "lint" };

  it("keeps its text, and only the artifacts given in their shape", async () => {
    expect(
      await serve({
        text: "exports: []\n",
        artifacts: [artifact, { ...artifact, kind: "x" }, { ...artifact, name: "Bad" }, 3],
      }),
    ).toEqual({ text: "exports: []\n", artifacts: [artifact] });
  });

  it("drops one that is not text within the bound", async () => {
    expect(await serve({ text: 3, artifacts: [] })).toBeUndefined();
    expect(
      await serve({ text: "x".repeat(MAX_SOURCE_MANIFEST + 1), artifacts: [] }),
    ).toBeUndefined();
    expect(await serve({ text: "", artifacts: {} })).toBeUndefined();
    expect(await serve("exports: []")).toBeUndefined();
  });
});

describe("what the client refuses from an adapter", () => {
  it.each([
    ["../escape.md"],
    ["/etc/passwd"],
    ["a\\b.md"],
    ["./SKILL.md"],
    [""],
    [".git/config"],
    [".GIT/hooks/pre-commit"],
    ["C:/x.md"],
  ])("rejects the published path %j", async (path) => {
    await expect(resolveWith(serving([{ path }]))).rejects.toThrow(AdapterError);
  });

  it("rejects two paths a case-insensitive disk stores as one", async () => {
    await expect(
      resolveWith(serving([{ path: "SKILL.md" }, { path: "skill.md" }])),
    ).rejects.toThrow('describes "skill.md" and "SKILL.md", which are one file on most disks');
  });

  it("rejects a kind the adapter did not declare", async () => {
    const adapter = serving([{ path: "SKILL.md" }]);
    const handle = await adapter.connect({
      source: { registry: "p", location: "probe://x", config: {}, key: "k" },
      credential: undefined,
      signal: new AbortController().signal,
      limits: { timeoutMs: 1000, retries: 0 },
      onBytes: () => {},
      cacheDir: () => "",
      exclusive: (_key, run) => run(),
    });
    const original = handle.resolve;
    handle.resolve = async (want) => {
      const listing = await original.call(handle, want);
      return { artifacts: listing.artifacts.map((a) => ({ ...a, kind: "agent" as const })) };
    };
    await expect(resolveArtifacts({ adapter, handle, key: "k" }, [])).rejects.toThrow(
      /does not serve/,
    );
  });

  it("files a grouped plugin under its own namespace, not a nested plugin path", async () => {
    const adapter: SourceAdapter = {
      ...serving([{ path: "SKILL.md" }]),
      artifactKinds: ["plugin", "skill"],
    };
    const handle = await adapter.connect({
      source: { registry: "p", location: "probe://x", config: {}, key: "k" },
      credential: undefined,
      signal: new AbortController().signal,
      limits: { timeoutMs: 1000, retries: 0 },
      onBytes: () => {},
      cacheDir: () => "",
      exclusive: (_key, run) => run(),
    });
    handle.resolve = async () => ({
      artifacts: [
        {
          id: "workspace:sales",
          kind: "plugin" as const,
          group: "sales",
          envelope: {
            apiVersion: ENVELOPE_API_VERSION,
            kind: "plugin",
            metadata: { name: "sales" },
            files: [{ path: "plugin.json", digest: `sha256:${"0".repeat(64)}`, size: 0 }],
          },
          files: [{ path: "plugin.json", locator: "plugin.json", executable: false }],
        },
      ],
    });
    const listing = await resolveArtifacts({ adapter, handle, key: "k" }, []);
    expect(listing.listed[0]?.path).toBe("artifacts/sales/plugin/sales");
    expect(listing.catalog.entries[0]?.group).toBe("sales");
  });

  it("accepts a well-formed listing", async () => {
    const listing = await resolveWith(serving([{ path: "SKILL.md" }]));
    expect(listing.listed).toHaveLength(1);
    // A registry with no namespaces files an artifact under its own name;
    // the mirror substitutes the alias, which only `stagedPath` knows.
    expect(listing.listed[0]?.path).toBe("artifacts/lint/skill/lint");
  });
});
