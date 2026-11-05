import { afterEach, describe, expect, test, vi } from "vitest";
import { parseYaml } from "#core/yaml.ts";
import { frontmatter } from "./frontmatter.ts";

const HOSTILE = 'foo: !!evil "\u001B]0;title\u0007"\n';

describe("parsing YAML a registry or a project wrote", () => {
  afterEach(() => vi.restoreAllMocks());

  test("never prints a warning, which would quote the source, escapes and all", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    expect(parseYaml(HOSTILE)).toEqual({ foo: "\u001B]0;title\u0007" });
    frontmatter(`---\n${HOSTILE}---\nbody\n`);
    expect(warn).not.toHaveBeenCalled();
  });

  test("still refuses a document that does not parse", () => {
    expect(() => parseYaml("a: [")).toThrow();
  });
});
