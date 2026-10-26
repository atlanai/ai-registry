import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { emptyRegistryConfig } from "#core/config/model.ts";
import { writeConfig } from "#core/config/repository.ts";
import type { ExtensionHost } from "#core/host/extend.ts";
import type { Printer } from "#core/output.ts";
import { SqliteRunStore } from "#daemon/run-store.ts";
import { homeTest as test } from "#test/kit/fixtures.ts";
import { collect } from "./state.ts";

/** A panel that finds its targets the way an adapter built against aireg 0.1 does. */
const EARLIER_PANEL = `export default {
  id: "kit",
  displayName: "Kit",
  protocol: 1,
  artifactKinds: ["skill"],
  dispatch: { hosts: ["kit.localhost"] },
  capabilities: {},
  connect: async () => ({ resolve: async () => ({ artifacts: [] }), fetch: async () => new Uint8Array(), close: async () => {} }),
  extend: {
    panels: [{
      id: "kit",
      label: "Kit",
      collect: async (input) =>
        Object.values(input.harnesses)
          .filter((target) => target.name === "claude" || target.name === "codex")
          .map((target) => target.displayName)
          .sort(),
      length: () => 0,
      render: () => null,
    }],
  },
};
`;

describe("collect", () => {
  test("hands a panel the targets by the ids aireg 0.1 knew", async ({ tmp, project }) => {
    const kit = join(tmp, "kit.mjs");
    await writeFile(kit, EARLIER_PANEL);
    await writeConfig({ ...emptyRegistryConfig(), adapters: { kit } }, 0);

    const state = await collect({
      argv: [],
      cwd: project,
      printer: {} as Printer,
      host: {
        version: "0.0.0",
        connectAccount: () => Promise.reject(new Error("A panel's collect connects nothing.")),
        openRunStore: () => SqliteRunStore.open(":memory:"),
      } satisfies ExtensionHost,
    });
    expect(state.problems).toEqual([]);
    expect(state.panels.kit).toEqual(["Claude Code", "Codex"]);
  });
});
