import { Type } from "@sinclair/typebox";
import type { InitResult } from "#cli/commands/init/result.ts";
import { matching, outputDocument } from "./match.ts";

const Written = {
  manifest: Type.String({ description: "The manifest's absolute path." }),
  scope: Type.Literal("project"),
  targets: Type.Array(Type.String()),
  imported: Type.Number({ description: "How many artifacts `--import` copied in." }),
};

const Init = matching<InitResult>()(
  Type.Union([
    Type.Object(
      {
        ...Written,
        next: Type.Array(Type.String(), { description: "The commands to run next." }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...Written,
        steps: Type.Array(
          Type.Object(
            { name: Type.String(), detail: Type.String() },
            { additionalProperties: false },
          ),
          { description: "With `--registry`, each step `init` took, in place of `next`." },
        ),
      },
      { additionalProperties: false },
    ),
  ]),
);

export const OUTPUT = outputDocument("init", { init: Init });
