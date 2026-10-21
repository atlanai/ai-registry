import { Type } from "@sinclair/typebox";
import { KINDS } from "#core/kinds.ts";
import { LOCK_VERSION } from "#core/lock.ts";

/** The shape of `manifest.lock.yml`, as written. Reading is deliberately looser. */

const Link = Type.Object(
  {
    harness: Type.String({ minLength: 1, description: "Harness name." }),
    path: Type.String({
      minLength: 1,
      description: "Relative to the scope base, so a committed lock is machine-independent.",
    }),
    mode: Type.Union([
      Type.Literal("symlink"),
      Type.Literal("junction"),
      Type.Literal("copy"),
      Type.Literal("fanout"),
    ]),
    digest: Type.Optional(
      Type.String({
        pattern: "^sha256:[0-9a-f]{64}$",
        description: "A copy's digest as written, so an edit to the harness's own copy is seen.",
      }),
    ),
  },
  { additionalProperties: false },
);

const Blocked = Type.Object(
  {
    harness: Type.String({ minLength: 1, description: "Harness name." }),
    path: Type.String({ minLength: 1, description: "Relative to the scope base." }),
    by: Type.Optional(Type.String({ minLength: 1, description: "What is at the path instead." })),
  },
  { additionalProperties: false },
);

const Registry = Type.Object(
  {
    source: Type.String({ minLength: 1, description: "The address, as resolved." }),
    adapter: Type.String({
      minLength: 1,
      description: "Which adapter served it, recorded even when the manifest left it out.",
    }),
    key: Type.String({
      pattern: "^sha256:[0-9a-f]{64}$",
      description: "Identity of what is read, independent of alias and of adapter.",
    }),
    config: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 }), {
        description: "Adapter-defined scope selection, opaque to the client.",
      }),
    ),
    revision: Type.Optional(
      Type.String({
        minLength: 1,
        description: "What the registry was at, when one revision covers every artifact.",
      }),
    ),
  },
  { additionalProperties: false },
);

const Origin = Type.Object(
  {
    harness: Type.String({ minLength: 1, description: "Whose folder conventions it follows." }),
    path: Type.String({ minLength: 1, description: "Relative to the scope base." }),
    step: Type.Optional(Type.String({ minLength: 1, description: "The step that claimed it." })),
  },
  { additionalProperties: false },
);

const Artifact = Type.Object(
  {
    registry: Type.String({ minLength: 1, description: "Key into `registries`." }),
    id: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Registry-owned and stable across a rename. Absent until a publish assigns one.",
      }),
    ),
    name: Type.String({ minLength: 1, description: "What the registry called it." }),
    kind: Type.Union(KINDS.map((kind) => Type.Literal(kind))),
    namespace: Type.Optional(
      Type.String({ minLength: 1, description: "The owner inside the registry." }),
    ),
    address: Type.Optional(
      Type.String({
        minLength: 1,
        description: "The file spec address the registry publishes it at, once published.",
      }),
    ),
    content: Type.Optional(
      Type.String({ minLength: 1, description: "Upstream content identity, once published." }),
    ),
    version: Type.Optional(
      Type.String({ description: "What the registry published, where it has versions." }),
    ),
    revision: Type.Optional(
      Type.String({
        pattern: "^[0-9a-f]{40}$",
        description:
          "The commit this artifact was read at, where it is its own, not its registry's.",
      }),
    ),
    carried: Type.Optional(
      Type.String({
        pattern: "^sha256:[0-9a-f]{64}$",
        description:
          "A digest of what a plugin has a harness start, so a background job sees it change.",
      }),
    ),
    path: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Where this scope's copy is, relative to its base.",
      }),
    ),
    digest: Type.String({
      minLength: 1,
      description: "Digest of what was placed, so a local edit is detectable.",
    }),
    origin: Type.Optional(
      Type.Union([Origin], {
        description: "Set when the bytes came from a folder here rather than from upstream.",
      }),
    ),
    links: Type.Array(Link, {
      description: "Only this list is pruned, so a file the CLI never wrote is never removed.",
    }),
    needed_by: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: "Installed artifacts whose `depends_on` edges name this version.",
      }),
    ),
    blocked: Type.Optional(
      Type.Array(Blocked, {
        minItems: 1,
        description:
          "Links asked for but not made, because something of yours is at the path. Never pruned.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const Lockfile = Type.Object(
  {
    version: Type.Literal(LOCK_VERSION, {
      description: "A lock of any other version is refused rather than guessed at.",
    }),
    registries: Type.Optional(Type.Record(Type.String(), Registry)),
    artifacts: Type.Optional(Type.Record(Type.String(), Artifact)),
  },
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "lockfile.schema.json",
    title: "manifest.lock.yml",
    description:
      "What a project resolved to, written by the CLI and read back on the next run. Timestamp-free on purpose, so two branches adding different artifacts merge without a conflict.",
    additionalProperties: false,
  },
);
