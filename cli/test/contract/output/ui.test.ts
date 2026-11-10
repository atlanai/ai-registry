import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type SchemaObject } from "ajv/dist/2020.js";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { serveUi } from "#test/kit/ui.ts";
import { OUTPUT_SCHEMAS } from "./kit.ts";

// `aireg ui` serves until stopped, so its one line is read from a running server.
test("ui prints data its schema describes", async ({ home, project }) => {
  const document = JSON.parse(
    readFileSync(join(OUTPUT_SCHEMAS, "ui.json"), "utf8"),
  ) as SchemaObject;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(document);
  const validate = ajv.getSchema(`${document.$id as string}#/$defs/ui`);
  const ui = await serveUi(home, project);
  try {
    expect(validate?.(ui.printed.data), ajv.errorsText(validate?.errors)).toBe(true);
  } finally {
    await ui.stop();
  }
});
