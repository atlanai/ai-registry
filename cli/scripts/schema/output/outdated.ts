import { Type } from "@sinclair/typebox";
import type { OutdatedResult } from "#cli/commands/outdated/result.ts";
import { matching, outputDocument } from "./match.ts";

const Watched = Type.Object(
  {
    target: Type.String(),
    harness: Type.String({ description: "`target` by the id aireg 0.1 used." }),
    path: Type.String(),
  },
  {
    additionalProperties: false,
    description: "Published from a watched folder, so `aireg update` never moves it.",
  },
);

const Outdated = matching<OutdatedResult>()(
  Type.Object(
    {
      scope: Type.Union([Type.Literal("user"), Type.Literal("project")]),
      artifacts: Type.Array(
        Type.Object(
          {
            name: Type.String(),
            registry: Type.String(),
            pinned: Type.Optional(Type.String({ description: "The version the manifest pins." })),
            watched: Type.Optional(Watched),
            current: Type.String({ description: "Empty for one not installed yet." }),
            latest: Type.String(),
            moved: Type.Boolean(),
            unchecked: Type.Optional(Type.String({ description: "Why it could not be checked." })),
            added: Type.Optional(
              Type.Literal(true, {
                description: "Published since the last install, under an entry taken whole.",
              }),
            ),
            unpublished: Type.Optional(Type.Literal(true)),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
);

export const OUTPUT = outputDocument("outdated", { outdated: Outdated });
