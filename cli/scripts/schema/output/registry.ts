import { Type } from "@sinclair/typebox";
import { KINDS } from "#adapter/kinds.ts";
import { LAYOUT_IDS } from "#adapter/layouts/ids.ts";
import type {
  RegistryAdded,
  RegistryCreated,
  RegistryIndexed,
  RegistryList,
  RegistryRemoved,
  RegistryShown,
  RegistryValidated,
} from "#cli/commands/registry/result.ts";
import { matching, oneOf, outputDocument } from "./match.ts";

const Kind = oneOf(KINDS);

const Declared = {
  registry: Type.String(),
  address: Type.String({ description: "The address, without credentials." }),
  adapter: Type.Optional(
    Type.String({ description: "Only for a registry declared with --adapter." }),
  ),
  config: Type.Record(Type.String(), Type.String()),
};

const Add = matching<RegistryAdded>()(
  Type.Object(
    {
      ...Declared,
      movedFrom: Type.Optional(
        Type.String({ description: "The old address, when the name moved." }),
      ),
      kept: Type.Optional(
        Type.Number({ description: "When the name moved, the installed artifacts it serves." }),
      ),
      readable: Type.Boolean({
        description: "`false` when the registry could not be read before you sign in.",
      }),
      dryRun: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
);

const List = matching<RegistryList>()(
  Type.Object(
    {
      scope: Type.Union([Type.Literal("project"), Type.Literal("user")]),
      registries: Type.Array(Type.Object(Declared, { additionalProperties: false })),
    },
    { additionalProperties: false },
  ),
);

const Show = matching<RegistryShown>()(
  Type.Object(
    {
      registry: Type.String(),
      address: Type.String(),
      revision: Type.Optional(Type.String({ description: "The commit read, for a git registry." })),
      layout: Type.Optional(
        oneOf(LAYOUT_IDS, { description: "Only for a source that is not a registry." }),
      ),
      layouts: Type.Array(Type.String(), { description: "How the registry was read." }),
      entries: Type.Array(
        Type.Object(
          {
            name: Type.String(),
            kind: Kind,
            namespace: Type.Optional(Type.String()),
            path: Type.String(),
            description: Type.Optional(Type.String()),
            engine: Type.Optional(
              Type.String({ description: "The oldest aireg that can install it." }),
            ),
            version: Type.Optional(
              Type.String({ description: "The version the registry serves." }),
            ),
          },
          { additionalProperties: false },
        ),
      ),
      warnings: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
);

const Remove = matching<RegistryRemoved>()(
  Type.Object(
    {
      registry: Type.String(),
      dryRun: Type.Boolean(),
      jobs: Type.Array(Type.String(), {
        description: "The ids of the jobs removed with it, or that would be.",
      }),
    },
    { additionalProperties: false },
  ),
);

const Init = matching<RegistryCreated>()(
  Type.Object(
    {
      root: Type.String(),
      created: Type.Boolean({ description: "`false` in a folder that is already a registry." }),
      slug: Type.String(),
      namespaces: Type.Array(Type.String(), {
        description: "In a registry already, only the namespaces added.",
      }),
    },
    { additionalProperties: false },
  ),
);

const Version = Type.Object(
  {
    namespace: Type.String(),
    kind: Kind,
    name: Type.String(),
    version: Type.String(),
    digest: Type.String(),
    description: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
    catalogDigest: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const Index = matching<RegistryIndexed>()(
  Type.Object(
    {
      root: Type.String(),
      added: Type.Array(Version),
      moved: Type.Array(Version, {
        description: "Artifacts whose `latest` moved without a new version.",
      }),
      paths: Type.Array(Type.String(), { description: "Root-relative paths written." }),
    },
    { additionalProperties: false },
  ),
);

const Validate = matching<RegistryValidated>()(
  Type.Object(
    {
      name: Type.String(),
      namespaces: Type.Number(),
      artifacts: Type.Number(),
      versions: Type.Number(),
      problems: Type.Array(
        Type.Object(
          { path: Type.String(), message: Type.String(), fix: Type.Optional(Type.String()) },
          { additionalProperties: false },
        ),
      ),
      warnings: Type.Array(Type.String()),
    },
    { additionalProperties: false, description: "Printed under `ok: false` when it has problems." },
  ),
);

export const OUTPUT = outputDocument("registry", {
  add: Add,
  list: List,
  show: Show,
  remove: Remove,
  init: Init,
  index: Index,
  validate: Validate,
});
