import { Type } from "@sinclair/typebox";
import { KINDS } from "#adapter/kinds.ts";
import type { ListResult } from "#cli/commands/list/result.ts";
import { LINK_MODES } from "#core/lock.ts";
import { matching, oneOf, outputDocument } from "./match.ts";

const Watched = Type.Object(
  {
    target: Type.String(),
    harness: Type.String({ description: "`target` by the id aireg 0.1 used." }),
    path: Type.String(),
  },
  {
    additionalProperties: false,
    description: "The folder it is published from, where its target reads it; nothing is linked.",
  },
);

const Listing = Type.Object(
  {
    scope: Type.Union([Type.Literal("user"), Type.Literal("project")]),
    artifacts: Type.Array(
      Type.Object(
        {
          name: Type.String({ description: "The artifact's name in the lockfile." }),
          shown: Type.String({ description: "The name the table prints." }),
          kind: Type.String(),
          registry: Type.String(),
          address: Type.String({ description: "Where its registry lives." }),
          ref: Type.String({
            description:
              "The version; else the registry's short commit, or empty for a watched folder's.",
          }),
          pinned: Type.Boolean(),
          targets: Type.Array(Type.String(), { description: "Linked into, by target id." }),
          watched: Type.Optional(Watched),
          neededBy: Type.Optional(
            Type.Array(Type.String(), {
              description: "What it is installed for, when the manifest does not ask for it.",
            }),
          ),
          harnesses: Type.Array(Type.String(), {
            description: "`targets` by the ids aireg 0.1 printed under it.",
          }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, description: "Everything installed." },
);

const Detail = Type.Object(
  {
    name: Type.String({ description: "As the command line named it." }),
    kind: oneOf(KINDS),
    registry: Type.String(),
    address: Type.Optional(Type.String()),
    adapter: Type.Optional(Type.String()),
    registryKey: Type.Optional(Type.String()),
    config: Type.Optional(Type.Record(Type.String(), Type.String())),
    revision: Type.Optional(Type.String()),
    id: Type.Optional(Type.String()),
    upstreamName: Type.String(),
    content: Type.Optional(Type.String()),
    version: Type.Optional(Type.String()),
    path: Type.String(),
    copy: Type.String({ description: "The stored copy every link leads to." }),
    watched: Type.Optional(Watched),
    links: Type.Array(
      Type.Object(
        {
          target: Type.String(),
          path: Type.String(),
          mode: oneOf(LINK_MODES),
          digest: Type.Optional(Type.String()),
          harness: Type.String({ description: "`target` by the id aireg 0.1 used." }),
        },
        { additionalProperties: false },
      ),
    ),
    neededBy: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false, description: "With a name: where that one artifact came from." },
);

const List = matching<ListResult>()(Type.Union([Listing, Detail]));

export const OUTPUT = outputDocument("list", { list: List });
