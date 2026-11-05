import { Type } from "@sinclair/typebox";
import type { KindBump, KindNewResult } from "#cli/commands/kind/result.ts";
import { matching, outputDocument } from "./match.ts";

const New = matching<KindNewResult>()(
  Type.Union([
    Type.Object(
      {
        kind: Type.String(),
        name: Type.String(),
        created: Type.Array(Type.String(), { description: "Paths from where it ran." }),
        todo: Type.Array(Type.String(), { description: "Fields left as TODO, dotted." }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.String(),
        namespace: Type.String(),
        created: Type.Array(
          Type.Object(
            {
              name: Type.String(),
              at: Type.String({ description: "The version's folder, from the registry's root." }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false, description: "With `--from`." },
    ),
  ]),
);

const Bump = matching<KindBump>()(
  Type.Object(
    {
      kind: Type.String(),
      name: Type.String(),
      from: Type.String({ description: "The version copied." }),
      to: Type.String({ description: "The version started." }),
    },
    { additionalProperties: false },
  ),
);

// Every kind a registry holds is a command of its own, and they all print this.
export const OUTPUT = {
  ...outputDocument("kind", { new: New, bump: Bump }),
  title: "aireg <kind> --json",
  description:
    "The `data` each `aireg <kind>` action, such as `aireg skill new`, prints under --json, by action.",
};
