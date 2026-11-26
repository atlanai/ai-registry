import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Lockfile } from "./lockfile.ts";
import { Manifest } from "./manifest.ts";
import { Target } from "./target.ts";

const OUTPUTS = join(import.meta.dirname, "output");

/** Each command's `--json` schema, from its module under `output/`, so adding one edits no list. */
const outputs = await Promise.all(
  readdirSync(OUTPUTS)
    .filter((name) => name.endsWith(".ts") && name !== "match.ts")
    .sort()
    .map(async (name) => {
      const module = (await import(join(OUTPUTS, name))) as { OUTPUT: object };
      return [`output/${name.replace(/\.ts$/, ".json")}`, module.OUTPUT] as const;
    }),
);

export const GENERATED: Readonly<Record<string, object>> = {
  "manifest.schema.json": Manifest,
  "lockfile.schema.json": Lockfile,
  "target.schema.json": Target,
  ...Object.fromEntries(outputs),
};

export const SCHEMA_DIR = join(import.meta.dirname, "..", "..", "schema");

/** Owned by the spec; bundled as copies, since a package cannot import outside itself. */
const SPEC_KINDS = join(import.meta.dirname, "..", "..", "..", "spec", "schemas", "kinds");

/**
 * Each kind manifest's path under `schema/`, with the spec's bytes it must hold, and with it
 * every schema a manifest refers to, such as Apache Ossie's under `kinds/vendor/`.
 */
export function kindCopies(): Record<string, string> {
  return {
    "kind-manifest.schema.json": readFileSync(
      join(SPEC_KINDS, "..", "kind-manifest.schema.json"),
      "utf8",
    ),
    ...Object.fromEntries(
      readdirSync(SPEC_KINDS, { recursive: true, encoding: "utf8" })
        .filter((name) => name.endsWith(".json") || name.endsWith(".md"))
        .sort()
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
  mkdirSync(join(SCHEMA_DIR, "output"), { recursive: true });
  for (const [name, text] of Object.entries(documents)) {
    mkdirSync(dirname(join(SCHEMA_DIR, name)), { recursive: true });
    writeFileSync(join(SCHEMA_DIR, name), text);
    process.stdout.write(`wrote schema/${name}\n`);
  }
}
