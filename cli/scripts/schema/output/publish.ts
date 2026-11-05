import { Type } from "@sinclair/typebox";
import { KINDS } from "#adapter/kinds.ts";
import type { PublishReport } from "#cli/commands/publish/result.ts";
import { matching, oneOf, outputDocument } from "./match.ts";

const Kind = oneOf(KINDS);

const Paths = Type.Array(Type.String());

const Artifact = Type.Object(
  {
    name: Type.String(),
    kind: Kind,
    registry: Type.String({
      description: "The registry's name, or for `--to <folder>`, the folder as `--to` gave it.",
    }),
    namespace: Type.String(),
    from: Type.Union([Type.String(), Type.Null()], {
      description: "The version published before, or `null` for a new artifact.",
    }),
    version: Type.String(),
    digest: Type.String({
      description: "The content's identity: its files and dependencies, not its version.",
    }),
    belowLatest: Type.Boolean(),
    published: Type.Boolean({
      description: "`false` for one already published, or under `--dry-run`.",
    }),
    dependsOn: Type.Array(Type.Object({ to: Type.String() }, { additionalProperties: false })),
    files: Type.Optional(Paths),
    filesChanged: Type.Optional(
      Type.Object(
        { added: Paths, changed: Paths, removed: Paths },
        { additionalProperties: false },
      ),
    ),
    dependsOnChanged: Type.Optional(
      Type.Object({ added: Paths, removed: Paths }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);

const Skipped = Type.Object(
  {
    name: Type.String(),
    kind: Kind,
    path: Type.String({ description: "Where it is, relative to the project." }),
    reason: Type.String(),
  },
  { additionalProperties: false },
);

const Publish = matching<PublishReport>()(
  Type.Object(
    {
      dryRun: Type.Boolean(),
      target: Type.Union(
        [
          Type.Object(
            { registry: Type.String(), namespace: Type.String() },
            { additionalProperties: false },
          ),
          Type.Null(),
        ],
        { description: "Where exports went; `null` when each went where it came from." },
      ),
      artifacts: Type.Array(Artifact),
      skipped: Type.Array(Skipped),
    },
    { additionalProperties: false },
  ),
);

export const OUTPUT = outputDocument("publish", { publish: Publish });
