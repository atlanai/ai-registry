import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertAdapterCompliance, ComplianceError } from "./compliance.ts";
import {
  ADAPTER_PROTOCOL,
  type Artifact,
  type PublishInput,
  type SourceAdapter,
  type SourceContext,
} from "./contract.ts";
import { defineAdapter } from "./define.ts";
import { ENVELOPE_API_VERSION } from "./spec/types.ts";

const BODY = new TextEncoder().encode("# lint\n");
const DIGEST = `sha256:${createHash("sha256").update(BODY).digest("hex")}`;

function context(): SourceContext {
  return {
    source: { registry: "probe", location: "probe://x", config: {}, key: "sha256:k" },
    credential: undefined,
    signal: new AbortController().signal,
    limits: { timeoutMs: 1000, retries: 0 },
    onBytes: () => {},
    cacheDir: () => "",
    exclusive: (_key, run) => run(),
  };
}

function serving(): SourceAdapter {
  return defineAdapter({
    id: "probe",
    displayName: "Probe",
    artifactKinds: ["skill"],
    dispatch: { schemes: ["probe"] },
    connect: async () => ({
      resolve: async () => ({
        artifacts: [
          {
            id: "skills/lint",
            kind: "skill",
            envelope: {
              apiVersion: ENVELOPE_API_VERSION,
              kind: "skill",
              metadata: { name: "lint" },
              files: [{ path: "SKILL.md", digest: DIGEST, size: BODY.byteLength }],
            },
            files: [{ path: "SKILL.md", locator: "SKILL.md", executable: false }],
          },
        ],
      }),
      fetch: async () => BODY,
      close: async () => {},
    }),
  });
}

describe("assertAdapterCompliance", () => {
  it("accepts a well-formed adapter", async () => {
    await expect(assertAdapterCompliance(serving(), context())).resolves.toBeUndefined();
  });

  it("refuses a sign-in the capabilities do not declare", async () => {
    const quiet: SourceAdapter = {
      ...serving(),
      auth: { login: async () => ({ credential: { type: "bearer", accessToken: "synthetic" } }) },
    };
    await expect(assertAdapterCompliance(quiet, context())).rejects.toThrow(
      "probe exported auth.login but did not declare auth.",
    );
  });

  it("refuses a digest mismatch and a publish flag without a method", async () => {
    const broken = serving();
    const original = broken.connect;
    broken.connect = async (ctx) => {
      const handle = await original.call(broken, ctx);
      return { ...handle, fetch: async () => new Uint8Array([1]) };
    };
    await expect(assertAdapterCompliance(broken, context())).rejects.toBeInstanceOf(
      ComplianceError,
    );

    const published = defineAdapter({
      id: "probe",
      displayName: "Probe",
      artifactKinds: ["skill"],
      dispatch: { schemes: ["probe"] },
      capabilities: { publish: true },
      connect: async () => ({
        resolve: async () => ({ artifacts: [] }),
        fetch: async () => new Uint8Array(),
        close: async () => {},
      }),
    });
    await expect(assertAdapterCompliance(published, context())).rejects.toThrow(/no publish/);
  });

  it("refuses a foreign protocol", async () => {
    const adapter = serving();
    (adapter as { protocol: number }).protocol = ADAPTER_PROTOCOL + 1;
    await expect(assertAdapterCompliance(adapter, context())).rejects.toThrow(/protocol/);
  });

  it("refuses an id a manifest could not name", async () => {
    const adapter = { ...serving(), id: "Probe.v2" };
    await expect(assertAdapterCompliance(adapter, context())).rejects.toThrow(/is not/);
  });

  it("refuses publishing a kind the adapter does not serve", async () => {
    const adapter = { ...serving(), publishKinds: ["agent" as const] };
    await expect(assertAdapterCompliance(adapter, context())).rejects.toThrow(
      /publishes agent it does not serve/,
    );
  });

  describe("relationships", () => {
    /** Publishes into memory, keeping each version's edges unless told to drop them. */
    function storing(keep: boolean, publish = true): SourceAdapter {
      const held: Artifact[] = [];
      return defineAdapter({
        id: "probe",
        displayName: "Probe",
        artifactKinds: ["skill"],
        dispatch: { schemes: ["probe"] },
        capabilities: { publish, relationships: true },
        connect: async () => ({
          resolve: async (want) => ({
            artifacts: held.filter((artifact) =>
              want.every((asked) => asked.name === artifact.envelope.metadata.name),
            ),
          }),
          fetch: async () => BODY,
          ...(publish
            ? {
                publish: async (changes: readonly PublishInput[]) => {
                  for (const change of changes) {
                    held.push({
                      id: change.name,
                      kind: change.kind,
                      envelope: {
                        apiVersion: ENVELOPE_API_VERSION,
                        kind: change.kind,
                        metadata: { name: change.name },
                        files: [],
                        ...(keep && change.relationships !== undefined
                          ? { relationships: [...change.relationships] }
                          : {}),
                      },
                      files: [],
                    });
                  }
                  return {};
                },
              }
            : {}),
          close: async () => {},
        }),
      });
    }

    it("publishes an artifact with an edge and reads it back", async () => {
      await expect(assertAdapterCompliance(storing(true), context())).resolves.toBeUndefined();
    });

    it("refuses an adapter that drops the edge", async () => {
      await expect(assertAdapterCompliance(storing(false), context())).rejects.toThrow(
        "probe declared relationships but aireg-compliance came back without the edge it was published with.",
      );
    });

    it("refuses relationships without publish", async () => {
      await expect(assertAdapterCompliance(storing(true, false), context())).rejects.toThrow(
        "probe declared relationships but does not publish.",
      );
    });
  });

  describe("agentFolders", () => {
    /** Publishes agents into memory, serving back every file, or only the first. */
    function storing(
      every: boolean,
      kinds: ("skill" | "agent")[] = ["skill", "agent"],
    ): SourceAdapter {
      const held: { artifact: Artifact; bytes: Map<string, Uint8Array> }[] = [];
      return defineAdapter({
        id: "probe",
        displayName: "Probe",
        artifactKinds: kinds,
        dispatch: { schemes: ["probe"] },
        capabilities: { publish: true, agentFolders: true },
        connect: async () => ({
          resolve: async (want) => ({
            artifacts: held
              .map((each) => each.artifact)
              .filter((artifact) =>
                want.every((asked) => asked.name === artifact.envelope.metadata.name),
              ),
          }),
          fetch: async (artifact, file) =>
            held.find((each) => each.artifact === artifact)?.bytes.get(file.path) ??
            new Uint8Array(),
          publish: async (changes: readonly PublishInput[]) => {
            for (const change of changes) {
              const files = every ? change.files : change.files.slice(0, 1);
              held.push({
                artifact: {
                  id: change.name,
                  kind: change.kind,
                  envelope: {
                    apiVersion: ENVELOPE_API_VERSION,
                    kind: change.kind,
                    metadata: { name: change.name },
                    files: [],
                  },
                  files: files.map((file) => ({
                    path: file.path,
                    locator: file.path,
                    executable: false,
                  })),
                },
                bytes: new Map(files.map((file) => [file.path, file.content])),
              });
            }
            return {};
          },
          close: async () => {},
        }),
      });
    }

    it("publishes an agent with a file beyond AGENT.md and reads it back", async () => {
      await expect(assertAdapterCompliance(storing(true), context())).resolves.toBeUndefined();
    });

    it("refuses an adapter that serves back only AGENT.md", async () => {
      await expect(assertAdapterCompliance(storing(false), context())).rejects.toThrow(
        "probe declared agentFolders but aireg-compliance-folder came back without notes/probe.md.",
      );
    });

    it("refuses agentFolders on an adapter that publishes no agent", async () => {
      await expect(assertAdapterCompliance(storing(true, ["skill"]), context())).rejects.toThrow(
        "probe declared agentFolders but publishes no agent.",
      );
    });
  });
});
