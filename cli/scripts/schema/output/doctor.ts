import { Type } from "@sinclair/typebox";
import type { DoctorResult } from "#cli/commands/doctor/result.ts";
import { matching, outputDocument } from "./match.ts";

const Flag = Type.Optional(Type.Boolean());

const Doctor = matching<DoctorResult>()(
  Type.Object(
    {
      problems: Type.Number({ description: "How many checks are not ok." }),
      checks: Type.Array(
        Type.Object(
          {
            name: Type.String(),
            ok: Type.Boolean(),
            detail: Type.String(),
            fix: Type.Optional(
              Type.String({
                description: "What fixes or improves it; commands joined with ` && `.",
              }),
            ),
            info: Type.Optional(
              Type.Boolean({ description: "Worth knowing, with nothing to do." }),
            ),
          },
          { additionalProperties: false },
        ),
      ),
      adapters: Type.Array(
        Type.Object(
          {
            id: Type.String(),
            displayName: Type.String(),
            capabilities: Type.Object(
              {
                pinsSource: Type.Boolean(),
                publish: Type.Boolean(),
                auth: Type.Boolean(),
                messages: Flag,
                fileSpec: Flag,
                namespacePlugins: Flag,
                relationships: Flag,
                agentFolders: Flag,
              },
              {
                additionalProperties: false,
                description: "A flag it does not advertise is false.",
              },
            ),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
);

export const OUTPUT = outputDocument("doctor", { doctor: Doctor });
