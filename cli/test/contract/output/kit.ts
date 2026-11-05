import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type SchemaObject } from "ajv/dist/2020.js";
import type { Aireg } from "#test/kit/fixtures.ts";

export const OUTPUT_SCHEMAS = join(import.meta.dirname, "..", "..", "..", "schema", "output");

export interface OutputContract {
  /** Runs `aireg <args> --json`: how its `data` breaks the action's schema, or "" when it holds. */
  violations(aireg: Aireg, args: readonly string[], action: string): Promise<string>;
  /** The actions the schema describes that no run has checked yet. */
  unchecked(): string[];
}

export function outputContract(command: string): OutputContract {
  const document = JSON.parse(
    readFileSync(join(OUTPUT_SCHEMAS, `${command}.json`), "utf8"),
  ) as SchemaObject;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(document);
  const checked = new Set<string>();
  return {
    async violations(aireg, args, action) {
      const ran = await aireg([...args, "--json"]);
      if (ran.code !== 0) return `exit ${ran.code}: ${ran.stderr}`;
      const validate = ajv.getSchema(`${document.$id as string}#/$defs/${action}`);
      if (validate === undefined) return `output/${command}.json describes no ${action}`;
      checked.add(action);
      return validate(ran.json().data) ? "" : ajv.errorsText(validate.errors);
    },
    unchecked: () => Object.keys(document.$defs as object).filter((action) => !checked.has(action)),
  };
}
