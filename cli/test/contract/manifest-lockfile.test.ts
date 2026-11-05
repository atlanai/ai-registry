import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type SchemaObject } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { formatLock, parseLock } from "#core/lock.ts";
import { EXPORT_KEYS, MANIFEST_KEYS, REGISTRY_KEYS } from "#core/manifest/model.ts";
import { parseManifest } from "#core/manifest/parse.ts";
import { GENERATED, kindCopies, render } from "#scripts/schema/generate.ts";

const SCHEMAS = join(import.meta.dirname, "..", "..", "schema");
const FIXTURES = join(import.meta.dirname, "..", "fixtures");

function validator(name: string) {
  const schema = JSON.parse(readFileSync(join(SCHEMAS, name), "utf8")) as SchemaObject;
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

function fixtures(kind: string): { name: string; text: string }[] {
  const dir = join(FIXTURES, kind);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

function accepts(read: (text: string) => unknown, text: string): boolean {
  try {
    read(text);
    return true;
  } catch {
    return false;
  }
}

// Schema and parser must agree, or one of them is lying to whoever edits the
// file. `invalid-semantic-` marks what a schema cannot reach.
describe("manifest.schema.json", () => {
  const validate = validator("manifest.schema.json");

  for (const { name, text } of fixtures("manifest")) {
    const shaped = validate(parse(text) ?? {});
    // Captured now: `validate.errors` is overwritten by the next fixture.
    const why = JSON.stringify(validate.errors);
    const parsed = accepts((input) => parseManifest(input), text);

    if (name.startsWith("invalid-semantic-")) {
      test(`${name}: only the parser can see it`, () => {
        expect(shaped, why).toBe(true);
        expect(parsed).toBe(false);
      });
      continue;
    }

    const both = name.startsWith("valid-");
    test(`${name}: ${both ? "both accept it" : "both reject it"}`, () => {
      expect(shaped, why).toBe(both);
      expect(parsed).toBe(both);
    });
  }
});

// Reading is deliberately looser, so the parser is not held to this answer.
describe("lockfile.schema.json", () => {
  const validate = validator("lockfile.schema.json");

  for (const { name, text } of fixtures("lockfile")) {
    const valid = name.startsWith("valid-");
    test(`${name}: the schema ${valid ? "accepts" : "rejects"} it`, () => {
      const shaped = validate(parse(text) ?? {});
      expect(shaped, JSON.stringify(validate.errors)).toBe(valid);
    });
  }

  test("accepts what the writer produces, which is the contract it describes", () => {
    for (const { name, text } of fixtures("lockfile")) {
      if (!name.startsWith("valid-")) continue;
      const written = parse(formatLock(parseLock(text)));
      expect(validate(written), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });
});

// Catches a key added to the parser that no fixture would mention.
describe("the schema describes every key the parser reads", () => {
  interface Node {
    properties?: Record<string, unknown>;
    patternProperties?: Record<string, Node>;
    anyOf?: Node[];
    items?: Node;
  }

  const schema = JSON.parse(
    readFileSync(join(SCHEMAS, "manifest.schema.json"), "utf8"),
  ) as Required<Pick<Node, "properties">> & Node;

  const props = (node: Node | undefined): string[] => Object.keys(node?.properties ?? {});

  // A `Record<string, T>` becomes one pattern property; this reaches `T`.
  const entry = (node: unknown): Node =>
    Object.values((node as Node).patternProperties ?? {})[0] ?? {};

  test("at the top level", () => {
    expect(Object.keys(schema.properties).sort()).toEqual([...MANIFEST_KEYS].sort());
  });

  test("on a registry, across every transport", () => {
    const described = new Set<string>();
    for (const branch of entry(schema.properties.registries).anyOf ?? []) {
      for (const key of props(branch)) described.add(key);
    }
    expect([...described].sort()).toEqual([...REGISTRY_KEYS].sort());
  });

  test("on an export", () => {
    const exports = schema.properties.exports as Node;
    const described = (exports.items?.anyOf ?? []).flatMap(props);
    expect(described.sort()).toEqual([...EXPORT_KEYS].sort());
  });
});

// The regenerate-and-diff gate, where it can name the command to run.
describe("the published schema is what the definitions produce", () => {
  for (const [name, definition] of Object.entries(GENERATED)) {
    test(`${name} is up to date`, () => {
      const onDisk = readFileSync(join(SCHEMAS, name), "utf8");
      expect(onDisk, "run `pnpm run schema` and commit the result").toBe(render(definition));
    });
  }
  for (const [name, text] of Object.entries(kindCopies())) {
    test(`${name} is the spec's`, () => {
      const onDisk = readFileSync(join(SCHEMAS, name), "utf8");
      expect(onDisk, "run `pnpm run schema` and commit the result").toBe(text);
    });
  }
});
