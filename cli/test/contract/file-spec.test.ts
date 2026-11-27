import { readdirSync, readFileSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { Ajv2020, type SchemaObject } from "ajv/dist/2020.js";
import draft07 from "ajv/dist/refs/json-schema-draft-07.json" with { type: "json" };
import { describe, expect, test } from "vitest";
import { buildEnvelope } from "#adapter/index.ts";

// The schemas live in the sibling `spec/` component, not in this package.
const SCHEMAS = join(import.meta.dirname, "..", "..", "..", "spec", "schemas");
const FIXTURE = join(import.meta.dirname, "..", "fixtures", "file-spec");

function ajv(): Ajv2020 {
  // The schemas declare `format` keywords ajv carries no validator for;
  // the shapes, not the string formats, are what is asserted.
  const compiler = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  // The MCP Registry's `server.json` schema is draft-07 (`kinds/vendor/mcp/README.md`).
  compiler.addMetaSchema(draft07);
  const parse = (path: string): SchemaObject =>
    JSON.parse(readFileSync(join(SCHEMAS, path), "utf8")) as SchemaObject;
  const load = (path: string): void => {
    compiler.addSchema(parse(path));
  };
  // Each file carries its own relative `$id`, which is what the cross-refs use.
  for (const name of readdirSync(SCHEMAS).filter((n) => n.endsWith(".schema.json"))) load(name);
  const kinds = readdirSync(join(SCHEMAS, "kinds"), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".json"))
    .map((name) => posix.join("kinds", ...name.split(sep)));
  for (const path of kinds) {
    // Another project's schema keeps that project's `$id`, so it is reached by its path here.
    if (path.includes("/vendor/")) compiler.addSchema(parse(path), path);
    else load(path);
  }
  return compiler;
}

function check(compiler: Ajv2020, schema: string, document: unknown): string[] {
  const validate = compiler.getSchema(schema);
  if (validate === undefined) throw new Error(`${schema} did not compile`);
  if (validate(document)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`);
}

const read = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURE, name), "utf8"));

const MCP_SERVER = join(
  import.meta.dirname,
  "../../../examples/acme-registry/artifacts/engineering/mcp_server/issue-tracker/1.2.0",
);

// Read in place from the spec, so they stay honest about the registries this client reads.
describe("the file spec schemas", () => {
  const compiler = ajv();

  test("accept a registry laid out by the current file spec", () => {
    expect(check(compiler, "registry.schema.json", read("registry.json"))).toEqual([]);
    expect(check(compiler, "index.schema.json", read("index.json"))).toEqual([]);
    expect(check(compiler, "versions.schema.json", read("versions.json"))).toEqual([]);
    expect(check(compiler, "artifact.schema.json", read("artifact.json"))).toEqual([]);
  });

  // The client normalizes what it reads and publishes nothing, so these are the
  // deliberate differences, asserted so none of them changes by accident.
  test("records where an envelope read from a working tree differs", () => {
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

describe("the mcp_server kind", () => {
  const compiler = ajv();
  const DOCUMENT = "kinds/mcp_server.json#/$defs/document";
  const read = (file: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(MCP_SERVER, file), "utf8")) as Record<string, unknown>;

  test("accepts the example server, its server.json checked by the MCP Registry schema", () => {
    expect(check(compiler, "artifact-known-kinds.schema.json", read("artifact.json"))).toEqual([]);
    expect(check(compiler, DOCUMENT, read("server.json"))).toEqual([]);
    const renamed = { ...read("server.json"), name: "issue-tracker" };
    expect(check(compiler, DOCUMENT, renamed)).toContain(
      '/name must match pattern "^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$"',
    );
  });

  test("takes only the server.json schema versions it vendors", () => {
    const future = {
      ...read("server.json"),
      $schema: "https://static.modelcontextprotocol.io/schemas/2099-01-01/server.schema.json",
    };
    expect(check(compiler, DOCUMENT, future)).toContain(
      "/$schema must be equal to one of the allowed values",
    );
  });

  test("holds only the slug and description in spec, never a copy of server.json", () => {
    const envelope = read("artifact.json") as { spec: Record<string, unknown> };
    envelope.spec.server = read("server.json");
    expect(check(compiler, "artifact-known-kinds.schema.json", envelope)).toContain(
      "/spec must NOT have additional properties",
    );
  });
});
