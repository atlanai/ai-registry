import { Type } from "@sinclair/typebox";
import { type BackupList, type BackupRestore, SKIP_REASONS } from "#cli/commands/backup/result.ts";
import { SCOPES } from "#core/store/paths.ts";
import { matching, oneOf, outputDocument } from "./match.ts";

const Named = {
  name: Type.String(),
  target: Type.String({ description: "The target folder it was moved out of." }),
};

const List = matching<BackupList>()(
  Type.Object(
    {
      scope: oneOf(SCOPES),
      root: Type.String({ description: "The scope's backups folder." }),
      runs: Type.Array(
        Type.Object(
          {
            stamp: Type.String({ description: "What `aireg backup restore <stamp>` takes." }),
            at: Type.Optional(Type.String({ description: "When it ran, as an ISO 8601 time." })),
            counts: Type.Record(Type.String(), Type.Number(), {
              description: "Items per target.",
            }),
            items: Type.Array(
              Type.Object(
                {
                  ...Named,
                  dir: Type.String({ description: "The folder within the target." }),
                  path: Type.String({ description: "Where it is now." }),
                  origin: Type.Optional(
                    Type.String({ description: "Where it was, when aireg can tell." }),
                  ),
                },
                { additionalProperties: false },
              ),
            ),
          },
          { additionalProperties: false, description: "Newest first." },
        ),
      ),
    },
    { additionalProperties: false },
  ),
);

const Restore = matching<BackupRestore>()(
  Type.Object(
    {
      scope: oneOf(SCOPES),
      stamp: Type.String(),
      restored: Type.Array(
        Type.Object(
          {
            ...Named,
            path: Type.String(),
            replaced: Type.Optional(
              Type.String({ description: "The new backup holding what stood there." }),
            ),
          },
          { additionalProperties: false },
        ),
      ),
      skipped: Type.Array(
        Type.Object(
          {
            ...Named,
            path: Type.Optional(Type.String({ description: "Where it would go back to." })),
            reason: oneOf(SKIP_REASONS),
            detail: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
);

export const OUTPUT = outputDocument("backup", { list: List, restore: Restore });
