import { describe, expect, it } from "vitest";
import { dropTable, readTable, setKeys, unsetKeys } from "./toml.ts";

const PLUGIN = ["plugins", "sales@acme-prod"];
const HEADING = '[plugins."sales@acme-prod"]';
const MARKETPLACE = ["marketplaces", "acme-prod"];
const CACHE = "/tmp/home/.codex/plugins/cache/acme-prod";

describe("TOML tables", () => {
  it("appends a missing table and leaves the rest of the file", () => {
    const next = setKeys('model = "gpt-5"\n', PLUGIN, { enabled: true });
    expect(next).toBe(`model = "gpt-5"\n\n${HEADING}\nenabled = true\n`);
    expect(setKeys("", MARKETPLACE, { source_type: "local", source: CACHE })).toBe(
      `[marketplaces.acme-prod]\nsource_type = "local"\nsource = "${CACHE}"\n`,
    );
  });

  it("rewrites its keys in place and keeps a person's", () => {
    const start = `${HEADING}\nenabled = false\napproval = "never"\n\n[other]\nx = 1\n`;
    expect(setKeys(start, PLUGIN, { enabled: true })).toBe(
      `${HEADING}\nenabled = true\napproval = "never"\n\n[other]\nx = 1\n`,
    );
    const ours = `[marketplaces.acme-prod]\nsource_type = "local"\nsource = "/old"\nnote = 1\n`;
    const next = setKeys(ours, MARKETPLACE, { source_type: "local", source: CACHE });
    expect(next).toBe(
      `[marketplaces.acme-prod]\nsource_type = "local"\nsource = "${CACHE}"\nnote = 1\n`,
    );
    expect(setKeys(next, MARKETPLACE, { source_type: "local", source: CACHE })).toBe(next);
  });

  it("finds a table however its heading is quoted or spaced", () => {
    const text = `[ marketplaces . "acme-prod" ] # ours\nsource = 'x'\n`;
    expect(readTable(text, MARKETPLACE)).toEqual({ source: "x" });
  });

  it("reads what a person set, including values it would never write", () => {
    const text = `[marketplaces.acme-prod]\nlast_updated = "2026-01-01T00:00:00Z"\nsource_type = "git"\nsource = "https://example.com/acme.git" # theirs\nretries = 3\nlist = [1]\n`;
    expect(readTable(text, MARKETPLACE)).toEqual({
      last_updated: "2026-01-01T00:00:00Z",
      source_type: "git",
      source: "https://example.com/acme.git",
      retries: 3,
      list: null,
    });
    expect(readTable(text, ["marketplaces", "other"])).toBeUndefined();
  });

  it("reads the root table, the keys before any heading", () => {
    const text =
      'name = "critic"\ndescription = "Reviews."\nbody = """\nlong\n"""\n\n[tools]\nx = 1\n';
    expect(readTable(text, [])).toEqual({ name: "critic", description: "Reviews.", body: null });
  });

  it("escapes a Windows path and reads it back", () => {
    const path = "C:\\Users\\ada\\.codex\\plugins\\cache\\acme-prod";
    const next = setKeys("", MARKETPLACE, { source: path });
    expect(next).toContain('source = "C:\\\\Users\\\\ada\\\\.codex');
    expect(readTable(next, MARKETPLACE)?.source).toBe(path);
  });

  it("drops a table and the blank line before it", () => {
    const start = `a = 1\n\n[marketplaces.acme-prod]\nsource_type = "local"\n\n[other]\nx = 1\n`;
    expect(dropTable(start, MARKETPLACE)).toBe("a = 1\n\n[other]\nx = 1\n");
    expect(dropTable(`a = 1\n\n${HEADING}\nenabled = true\n`, PLUGIN)).toBe("a = 1\n");
    expect(dropTable(`${HEADING}\nenabled = true\n`, PLUGIN)).toBe("");
    expect(dropTable("a = 1\n", MARKETPLACE)).toBe("a = 1\n");
  });

  it("unsets only the keys it is given", () => {
    const start = `${HEADING}\nenabled = true\napproval = "never"\n`;
    expect(unsetKeys(start, PLUGIN, ["enabled"])).toBe(`${HEADING}\napproval = "never"\n`);
  });

  it("keeps CRLF line endings", () => {
    const next = setKeys("a = 1\r\n", PLUGIN, { enabled: true });
    expect(next).toBe(`a = 1\r\n\r\n${HEADING}\r\nenabled = true\r\n`);
  });

  it("refuses a file that is not text", () => {
    expect(() => setKeys("a\0b", PLUGIN, { enabled: true })).toThrow(/not text/);
  });

  it("refuses to edit a table the file sets some other way", () => {
    for (const text of [
      'plugins."sales@acme-prod".enabled = false\n',
      '[plugins]\n"sales@acme-prod" = { enabled = false }\n',
      '[plugins]\n"sales@acme-prod".enabled = false\n',
      '[[plugins."sales@acme-prod"]]\nenabled = false\n',
    ]) {
      expect(() => setKeys(text, PLUGIN, { enabled: true }), text).toThrow(
        `sets ${HEADING} other than under its own heading`,
      );
    }
  });

  it("reads a multi-line value as one value, wherever its lines start", () => {
    const start = `${HEADING}\nargs = [\n  [1, 2],\n]\nnote = """\nenabled = false\n[other]\n"""\nenabled = false\n\n[other]\nx = 1\n`;
    expect(readTable(start, PLUGIN)).toEqual({ args: null, note: null, enabled: false });
    expect(setKeys(start, PLUGIN, { enabled: true })).toBe(
      start.replace("enabled = false\n\n", "enabled = true\n\n"),
    );
    expect(unsetKeys(start, PLUGIN, ["note"])).toBe(
      `${HEADING}\nargs = [\n  [1, 2],\n]\nenabled = false\n\n[other]\nx = 1\n`,
    );
  });
});
