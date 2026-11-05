import { stripVTControlCharacters } from "node:util";
import { renderToString } from "ink";
import { describe, expect, test } from "vitest";
import type { ArtifactRow } from "#core/console/model.ts";
import { artifactDetail, withLine } from "./overlays.ts";

describe("withLine", () => {
  test("keeps only what the activity panel can show, newest last", () => {
    let lines: string[] = [];
    for (let index = 0; index < 1_000; index += 1) lines = withLine(lines, `line ${index}`);
    expect(lines).toHaveLength(16);
    expect(lines[0]).toBe("line 984");
    expect(lines.at(-1)).toBe("line 999");
  });
});

describe("artifactDetail", () => {
  test("draws lockfile text as inert text", () => {
    const link = (text: string) => `\u001B]8;;https://example.test/\u0007${text}\u001B]8;;\u0007`;
    const row: ArtifactRow = {
      key: "team/lint",
      name: "lint",
      kind: "skill",
      registry: `kit${link("x")}`,
      namespace: `team\u001B[8mhidden\u001B[0m`,
      id: `id-${link("1")}`,
      version: `1.0.0${link("x")}`,
      lockDigest: "sha256:0000000",
      diskDigest: undefined,
      state: "ok",
      detail: undefined,
      targets: [],
      copy: "",
      changedAtMs: undefined,
      links: [],
    };
    const drawn = renderToString(
      artifactDetail({ width: 100, row, url: undefined, app: "the registry" }),
      { columns: 100 },
    );
    expect(drawn).not.toContain("\u001B]8;");
    expect(drawn).not.toContain("\u001B[8m");
    const shown = stripVTControlCharacters(drawn);
    expect(shown).toContain("teamhidden / lint");
    expect(shown).toContain("1.0.0x");
    expect(shown).toContain("from kitx");
    expect(shown).toContain("id-1");
  });
});
