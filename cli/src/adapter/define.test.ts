import { describe, expect, it } from "vitest";
import { ADAPTER_PROTOCOL } from "./contract.ts";
import { defineAdapter } from "./define.ts";

describe("defineAdapter", () => {
  it("defaults protocol and fills missing capability flags", () => {
    const adapter = defineAdapter({
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
    expect(adapter.protocol).toBe(ADAPTER_PROTOCOL);
    expect(adapter.capabilities).toEqual({
      pinsSource: false,
      publish: true,
      auth: false,
      messages: false,
      fileSpec: false,
      namespacePlugins: false,
      relationships: false,
      agentFolders: false,
    });
  });

  it("refuses an id that is not a path segment, and a foreign protocol", () => {
    const base = {
      displayName: "Probe",
      artifactKinds: ["skill" as const],
      dispatch: { schemes: ["probe"] },
      connect: async () => ({
        resolve: async () => ({ artifacts: [] }),
        fetch: async () => new Uint8Array(),
        close: async () => {},
      }),
    };
    for (const id of ["  ", "Probe", "acme.probe", "../probe"]) {
      expect(() => defineAdapter({ ...base, id })).toThrow(/is not lowercase/);
    }
    expect(() => defineAdapter({ ...base, id: "probe", protocol: 2 as 1 })).toThrow(/protocol 2/);
  });
});
