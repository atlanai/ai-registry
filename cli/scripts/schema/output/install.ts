import { type TProperties, Type } from "@sinclair/typebox";
import type { InstallResult } from "#cli/commands/install/result.ts";
import { matching, outputDocument } from "./match.ts";

/** The fields of a run's result that `add`, `install` and `update` share. */
export const OUTCOME = {
  dryRun: Type.Boolean(),
  changed: Type.Number({
    description: "The changes made; for a dry run, the changes it would make.",
  }),
  installed: Type.Array(Type.String(), { description: "The artifacts linked into a target." }),
  kept: Type.Array(
    Type.Object(
      {
        name: Type.String(),
        path: Type.String(),
        reason: Type.Optional(Type.String()),
        config: Type.Optional(Type.Literal(true)),
      },
      { additionalProperties: false },
    ),
    {
      description:
        "Links not made because something of the person's is already there; empty for a dry run.",
    },
  ),
  renamed: Type.Optional(
    Type.Array(
      Type.Object(
        { artifact: Type.String(), as: Type.String(), by: Type.String() },
        { additionalProperties: false },
      ),
      { description: "Installed under another name because its own is taken." },
    ),
  ),
  unlinked: Type.Optional(
    Type.Array(
      Type.Object(
        { artifact: Type.String(), by: Type.String(), at: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
      { description: "Not installed because its name is taken." },
    ),
  ),
} satisfies TProperties;

const Install = matching<InstallResult>()(
  Type.Object(
    {
      ...OUTCOME,
      unchanged: Type.Array(Type.String(), {
        description: "The artifacts already up to date.",
      }),
    },
    { additionalProperties: false },
  ),
);

export const OUTPUT = outputDocument("install", { install: Install });
