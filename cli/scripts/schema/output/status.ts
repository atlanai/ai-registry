import { Type } from "@sinclair/typebox";
import { KINDS } from "#adapter/kinds.ts";
import type { StatusResult } from "#cli/commands/status/result.ts";
import { matching, oneOf, outputDocument } from "./match.ts";

const LinkState = Type.Union(
  [
    Type.Literal("linked"),
    Type.Literal("missing"),
    Type.Literal("replaced"),
    Type.Literal("foreign"),
  ],
  { description: "How one target sees the artifact." },
);

const Artifact = Type.Object(
  {
    name: Type.String(),
    state: Type.Union(
      [
        Type.Literal("ok"),
        Type.Literal("missing"),
        Type.Literal("dangling"),
        Type.Literal("edited"),
      ],
      { description: "`dangling` is what the table calls `replaced`." },
    ),
    detail: Type.Optional(
      Type.String({ description: "Why it is not `ok`, starting with the folder." }),
    ),
    targets: Type.Record(Type.String(), LinkState, { description: "By target id." }),
    blocked: Type.Optional(Type.Literal(true)),
    taken: Type.Optional(Type.Literal(true)),
    harnesses: Type.Record(Type.String(), LinkState, {
      description: "`targets` by the ids aireg 0.1 used.",
    }),
    neededBy: Type.Optional(Type.Array(Type.String())),
    needsApproval: Type.Optional(
      Type.Array(
        Type.Object(
          { target: Type.String(), harness: Type.String(), run: Type.String() },
          {
            additionalProperties: false,
            description: "A command a person runs before the target loads it; never run.",
          },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

const Unmanaged = Type.Object(
  {
    name: Type.String(),
    kind: oneOf(KINDS),
    targets: Type.Array(Type.String()),
    path: Type.String(),
    harnesses: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const Dangling = Type.Object(
  { path: Type.String(), target: Type.String(), harness: Type.String() },
  {
    additionalProperties: false,
    description: "As aireg 0.1 printed it: `target` is what the link names, `harness` its folder.",
  },
);

const Status = matching<StatusResult>()(
  Type.Object(
    {
      scope: Type.Union([Type.Literal("user"), Type.Literal("project")]),
      artifacts: Type.Array(Artifact),
      shadowed: Type.Array(Type.String(), {
        description: "Installed both here and in the user scope; always empty for -g.",
      }),
      unmanaged: Type.Array(Unmanaged),
      dangling: Type.Array(Dangling),
    },
    { additionalProperties: false },
  ),
);

export const OUTPUT = outputDocument("status", { status: Status });
