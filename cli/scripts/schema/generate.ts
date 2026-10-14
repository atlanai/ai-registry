import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Lockfile } from "./lockfile.ts";
import { Manifest } from "./manifest.ts";

export const GENERATED = {
  "manifest.schema.json": Manifest,
  "lockfile.schema.json": Lockfile,
} as const;

/** Published, so the generated documents live apart from the definitions. */
export const SCHEMA_DIR = join(import.meta.dirname, "..", "..", "schema");

/** The spec owns the kind manifests; the CLI bundles copies, since an import cannot leave the package. */
const SPEC_KINDS = join(import.meta.dirname, "..", "..", "..", "spec", "schemas", "kinds");

/** Each kind manifest's path under `schema/`, with the spec's bytes it must hold. */
export function kindCopies(): Record<string, string> {
  return {
    "kind-manifest.schema.json": readFileSync(
      join(SPEC_KINDS, "..", "kind-manifest.schema.json"),
      "utf8",
    ),
    ...Object.fromEntries(
      readdirSync(SPEC_KINDS)
        .filter((name) => name.endsWith(".json"))
        .map((name) => [join("kinds", name), readFileSync(join(SPEC_KINDS, name), "utf8")]),
    ),
  };
}

export function render(schema: unknown): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

if (process.argv[1]?.endsWith("generate.ts") === true) {
  const documents = {
    ...Object.fromEntries(Object.entries(GENERATED).map(([name, s]) => [name, render(s)])),
    ...kindCopies(),
  };
  mkdirSync(join(SCHEMA_DIR, "kinds"), { recursive: true });
  for (const [name, text] of Object.entries(documents)) {
    writeFileSync(join(SCHEMA_DIR, name), text);
    process.stdout.write(`wrote schema/${name}\n`);
  }
}
