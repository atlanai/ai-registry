import { Type } from "@sinclair/typebox";
import type { RemoveResult } from "#cli/commands/remove/result.ts";
import { matching, outputDocument } from "./match.ts";

const Remove = matching<RemoveResult>()(
  Type.Object(
    {
      dryRun: Type.Boolean(),
      removed: Type.Array(Type.String(), {
        description: "Named and removed; one another artifact still needs stays, and is not here.",
      }),
      pruned: Type.Array(Type.String(), { description: "Dependencies removed with them." }),
      watched: Type.Array(Type.String(), {
        description: "Kept because a job publishes them from the person's own folders.",
      }),
    },
    { additionalProperties: false },
  ),
);

export const OUTPUT = outputDocument("remove", { remove: Remove });
