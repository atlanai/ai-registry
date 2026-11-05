import { Type } from "@sinclair/typebox";
import type { SearchResult } from "#cli/commands/search/result.ts";
import { Kind } from "#scripts/schema/kind.ts";
import { matching, outputDocument } from "./match.ts";

const Search = matching<SearchResult>()(
  Type.Object(
    {
      query: Type.String(),
      matches: Type.Array(
        Type.Object(
          {
            address: Type.String({ description: "What `aireg add` takes for it." }),
            registry: Type.String(),
            namespace: Type.Optional(Type.String()),
            kind: Kind,
            name: Type.String(),
            version: Type.Optional(Type.String()),
            description: Type.Optional(Type.String()),
            labels: Type.Optional(
              Type.Record(Type.String(), Type.String(), {
                description: "The spec's indexable string pairs, read as tags.",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        { description: "Best first." },
      ),
      skipped: Type.Array(
        Type.Object(
          { registry: Type.String(), message: Type.String() },
          { additionalProperties: false, description: "A registry that could not be read." },
        ),
      ),
    },
    { additionalProperties: false },
  ),
);

export const OUTPUT = outputDocument("search", { search: Search });
