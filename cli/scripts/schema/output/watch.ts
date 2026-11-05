import { Type } from "@sinclair/typebox";
import type { WatchList, WatchRemoveResult } from "#cli/commands/watch/result.ts";
import { SCOPES } from "#core/store/paths.ts";
import { Saved } from "./job.ts";
import { matching, oneOf, outputDocument } from "./match.ts";

const List = matching<WatchList>()(
  Type.Object(
    {
      watches: Type.Array(
        Type.Object(
          {
            folder: Type.String(),
            to: Type.String({ description: "Where it publishes, as <registry>/<namespace>." }),
            jobId: Type.String(),
            scope: oneOf(SCOPES),
            root: Type.String({ description: "The scope's folder." }),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
);

const Removed = Type.Object(
  {
    jobId: Type.String(),
    watching: Type.Array(Type.String(), {
      description: "The folders the job still watches.",
    }),
  },
  { additionalProperties: false },
);

const RemoveResult = matching<WatchRemoveResult>()(
  Type.Union([
    Removed,
    Type.Object(
      { jobs: Type.Array(Removed) },
      { additionalProperties: false, description: "When the folders belonged to several jobs." },
    ),
  ]),
);

// `add` saves the same job `job add` does, so it prints the same data.
export const OUTPUT = outputDocument("watch", { add: Saved, remove: RemoveResult, list: List });
