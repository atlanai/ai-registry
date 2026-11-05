import { Type } from "@sinclair/typebox";
import { LAYOUT_IDS } from "#adapter/layouts/ids.ts";
import type { AddResult } from "#cli/commands/add/result.ts";
import { OUTCOME } from "./install.ts";
import { matching, oneOf, outputDocument } from "./match.ts";

const Add = matching<AddResult>()(
  Type.Object(
    {
      registry: Type.String(),
      artifacts: Type.Array(Type.String(), {
        description: "The full names added to the manifest.",
      }),
      layout: Type.Optional(
        oneOf(LAYOUT_IDS, { description: "Present for a source that is not a registry." }),
      ),
      dependencies: Type.Record(Type.String(), Type.Array(Type.String()), {
        description: "Each artifact installed only because others depend on it, to their names.",
      }),
      ...OUTCOME,
      jobId: Type.Optional(
        Type.String({ description: "The background job that keeps a user scope install current." }),
      ),
    },
    { additionalProperties: false },
  ),
);

export const OUTPUT = outputDocument("add", { add: Add });
