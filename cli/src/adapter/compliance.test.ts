import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertAdapterCompliance, ComplianceError } from "./compliance.ts";
import { ADAPTER_PROTOCOL, type SourceAdapter, type SourceContext } from "./contract.ts";
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
});
