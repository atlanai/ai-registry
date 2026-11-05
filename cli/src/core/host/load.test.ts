import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { emptyRegistryConfig } from "#core/config/model.ts";
import { writeConfig } from "#core/config/repository.ts";
import { ADAPTER } from "#test/kit/daemon.ts";
import { homeTest as test } from "#test/kit/fixtures.ts";
import {
  contributedCommands,
  contributedPanels,
  contributedUpstream,
  stepContribution,
} from "./load.ts";

/** An adapter module whose hook contributes one of everything. */
const CONTRIBUTING = `export default {
  id: "kit",
  displayName: "Kit",
  protocol: 1,
  artifactKinds: ["skill"],
  dispatch: { hosts: ["kit.localhost"] },
  capabilities: {},
  connect: async () => ({ resolve: async () => ({ artifacts: [] }), fetch: async () => new Uint8Array(), close: async () => {} }),
  extend: {
    commands: [{ name: "kit", summary: "Kit things", group: "Kit", load: async () => ({ run: async () => {} }) }],
    panels: [
      { id: "kit", label: "Kit", collect: async () => ({}), length: () => 0, render: () => null },
      { id: "jobs", label: "Jobs", collect: async () => ({}), length: () => 0, render: () => null },
    ],
    upstream: { app: "Kit" },
  },
};
`;

describe("adapter extensions", () => {
  test("come from every adapter that loads, past one whose module is broken", async ({ tmp }) => {
    const kit = join(tmp, "kit.mjs");
    const broken = join(tmp, "broken.mjs");
    await writeFile(kit, CONTRIBUTING);
    await writeFile(broken, 'throw new Error("broken on import");\n');
    await writeConfig({ ...emptyRegistryConfig(), adapters: { broken, dev: ADAPTER, kit } }, 0);

    expect((await stepContribution("probe"))?.kind).toBe("probe");
    expect((await contributedCommands()).map(({ name }) => name)).toEqual(["kit"]);
    // One with the id of aireg's own jobs view would replace it and add a second tab.
    expect((await contributedPanels()).map(({ id }) => id)).toEqual(["kit"]);
    expect((await contributedUpstream())?.app).toBe("Kit");
  });
});
