import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type SchemaObject } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { buildEnvelope } from "#adapter/index.ts";

// The schemas live in the sibling `spec/` component, not in this package.
const SCHEMAS = join(import.meta.dirname, "..", "..", "..", "spec", "schemas");
const FIXTURE = join(import.meta.dirname, "..", "fixtures", "file-spec");

function ajv(): Ajv2020 {
  // The schemas declare `format` keywords ajv carries no validator for;
  // the shapes, not the string formats, are what is asserted.
  const compiler = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  const load = (path: string): void => {
    compiler.addSchema(JSON.parse(readFileSync(join(SCHEMAS, path), "utf8")) as SchemaObject);
  };
  // Each file carries its own relative `$id`, which is what the cross-refs use.
  for (const name of readdirSync(SCHEMAS).filter((n) => n.endsWith(".schema.json"))) load(name);
  for (const name of readdirSync(join(SCHEMAS, "kinds"))) load(join("kinds", name));
  return compiler;
}

function check(compiler: Ajv2020, schema: string, document: unknown): string[] {
  const validate = compiler.getSchema(schema);
  if (validate === undefined) throw new Error(`${schema} did not compile`);
  if (validate(document)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`);
}

const read = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURE, name), "utf8"));

/** Read in place from the spec, so they stay honest about the registries this client reads. */
describe("the file spec schemas", () => {
  const compiler = ajv();

  it("accept a registry laid out by the current file spec", () => {
    expect(check(compiler, "registry.schema.json", read("registry.json"))).toEqual([]);
    expect(check(compiler, "index.schema.json", read("index.json"))).toEqual([]);
    expect(check(compiler, "versions.schema.json", read("versions.json"))).toEqual([]);
    expect(check(compiler, "artifact.schema.json", read("artifact.json"))).toEqual([]);
  });

  /**
   * The client normalizes what it reads and publishes nothing, so these are the
   * deliberate differences, asserted so none of them changes by accident.
   */
  it("records where an envelope read from a working tree differs", () => {
    // A working tree sits in no namespace, publishes no version, and has no
    // kind document to carry, so a reader's envelope is not a publishable one.
    const readFromATree = buildEnvelope({
      kind: "skill",
      metadata: { name: "lint" },
      files: [
        { path: "SKILL.md", digest: `sha256:${"b".repeat(64)}`, size: 3, urls: ["SKILL.md"] },
      ],
    });
    expect(check(compiler, "artifact.schema.json", readFromATree).sort()).toEqual([
      "/ must have required property 'spec'",
      "/metadata must have required property 'namespace'",
      "/metadata must have required property 'version'",
    ]);
  });
});
