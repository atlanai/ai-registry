import { Type } from "@sinclair/typebox";
import type { UnlockResult } from "#cli/commands/unlock/result.ts";
import { matching, outputDocument } from "./match.ts";

const Scope = Type.Union([Type.Literal("user"), Type.Literal("project")]);

const Holder = Type.Object(
  {
    id: Type.String({ description: "What `aireg unlock <id>` takes." }),
    scope: Type.String(),
    lock: Type.String(),
    host: Type.String(),
    pid: Type.Number(),
    acquiredAtMs: Type.Number({ description: "When it was taken, in milliseconds since 1970." }),
  },
  { additionalProperties: false },
);

const Unlock = matching<UnlockResult>()(
  Type.Union([
    Type.Object(
      { scope: Scope, held: Type.Literal(false) },
      { additionalProperties: false, description: "Nothing is writing to the scope." },
    ),
    Type.Object(
      { scope: Scope, held: Type.Literal(true), holder: Holder },
      { additionalProperties: false, description: "The process writing to the scope." },
    ),
    Type.Object(
      { scope: Scope, broken: Holder },
      { additionalProperties: false, description: "The lock `aireg unlock <id>` cleared." },
    ),
  ]),
);

export const OUTPUT = outputDocument("unlock", { unlock: Unlock });
