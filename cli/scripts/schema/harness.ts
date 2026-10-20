import { type TObject, type TSchema, Type } from "@sinclair/typebox";
import type { ConfigValue as Value } from "#core/harness/contract.ts";

/** The shape of a harness file in `$AIREG_HOME/harnesses/`. The loader stays the authority. */

const PROGRAM = "^[A-Za-z0-9][A-Za-z0-9._+-]*$";
const VARIABLE = "^[A-Za-z_][A-Za-z0-9_]*$";

/** A shared definition, written once under `$defs`. */
const ref = (name: string) => Type.Unsafe({ $ref: `#/$defs/${name}` });

/** One of a few words, which an editor offers and an error lists. */
const choice = (...values: string[]) => Type.Unsafe<string>({ type: "string", enum: values });

/** Objects told apart by `tag`, so only the one it names is checked. */
const tagged = (tag: string, branches: TObject[], description: string) =>
  Type.Unsafe({
    type: "object",
    required: [tag],
    discriminator: { propertyName: tag },
    oneOf: branches,
    description,
  });

const Text = Type.String({ minLength: 1 });
const Texts = Type.Array(Text);

const ConfigValue = Type.Unsafe<Value>({
  type: ["string", "number", "boolean", "array", "object"],
  description: "Text, a number, true or false, a list or a table; text takes templates.",
});
const ConfigTable = Type.Record(Type.String(), ref("value"));

const Codec = tagged(
  "id",
  [
    Type.Object(
      { id: Type.Literal("frontmatter-toml"), fields: Texts, body: Text },
      {
        additionalProperties: false,
        description: "The front-matter fields, each required, and the body under `body`, as TOML.",
      },
    ),
    Type.Object(
      { id: Type.Literal("frontmatter-strict"), keep: Texts, restrictions: Type.Optional(Texts) },
      {
        additionalProperties: false,
        description:
          "Only the front-matter keys in `keep`; dropping a key that limits the agent, or one of `restrictions`, is refused.",
      },
    ),
    Type.Object(
      { id: Type.Literal("frontmatter-set"), set: ConfigTable, restrictions: Type.Optional(Texts) },
      {
        additionalProperties: false,
        description:
          "Front-matter keys set to fixed values; changing a key that limits the agent, or one of `restrictions`, is refused.",
      },
    ),
  ],
  "A codec aireg builds in, which rewrites the file a harness reads in its own format.",
);

const Manifest = Type.Object(
  {
    path: Type.String({ minLength: 1, description: "Relative to the plugin directory." }),
    body: Type.Optional(ConfigTable),
  },
  { additionalProperties: false },
);

const Register = Type.Object(
  {
    file: Type.String({ minLength: 1, description: "Relative to the harness root." }),
    format: choice("toml", "json", "yaml"),
    at: Type.Array(Text, {
      minItems: 1,
      description: "Key path to the table this entry writes in.",
    }),
    init: Type.Optional(ConfigTable),
    conflict: Type.Optional(choice("overwrite", "keep")),
    remove: Type.Optional(choice("ours", "entry")),
    off: Type.Optional(ConfigTable),
    value: Type.Optional(ConfigTable),
    upsert: Type.Optional(
      Type.Object({ key: Text, item: ConfigTable }, { additionalProperties: false }),
    ),
    append: Type.Optional(Text),
  },
  {
    additionalProperties: false,
    oneOf: [{ required: ["value"] }, { required: ["upsert"] }, { required: ["append"] }],
    description: "One edit to a config file the harness reads: `value`, `upsert` or `append`.",
  },
);

const Scope = Type.Optional(
  Type.Literal("user", { description: "Read from the user installation alone." }),
);

const KindMapping = tagged(
  "shape",
  [
    Type.Object({ shape: Type.Literal("contents") }, { additionalProperties: false }),
    Type.Object(
      {
        shape: Type.Literal("directory"),
        subdir: Text,
        scope: Scope,
        place: Type.Optional(choice("link", "fan", "copy")),
        entry: Type.Optional(Text),
        manifest: Type.Optional(Type.Array(Manifest)),
        register: Type.Optional(Type.Array(ref("register"))),
        codec: Type.Optional(ref("codec")),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        shape: Type.Literal("file"),
        subdir: Text,
        extension: Type.String({ pattern: "^\\.[A-Za-z0-9.]+$" }),
        scope: Scope,
        place: Type.Optional(choice("link", "copy")),
        codec: Type.Optional(ref("codec")),
        render: Type.Optional(
          Type.Object(
            { format: Type.Literal("toml"), fields: Texts, body: Text },
            {
              additionalProperties: false,
              description: "Deprecated: use the frontmatter-toml codec.",
            },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  ],
  "Where one kind lands inside the harness's folder.",
);

const PerKind = <T extends TSchema>(schema: T) =>
  Type.Object(
    {
      plugin: Type.Optional(schema),
      skill: Type.Optional(schema),
      agent: Type.Optional(schema),
    },
    { additionalProperties: false },
  );

export const Harness = Type.Object(
  {
    $schema: Type.Optional(
      Type.String({ description: "Ignored by the CLI; lets an editor find this schema." }),
    ),
    id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$", description: "The name `--for` takes." }),
    displayName: Text,
    overrides: Type.Optional(
      Type.Boolean({ description: "Replaces the built-in harness with this id." }),
    ),
    kind: Type.Optional(choice("coding", "personal", "shared")),
    roots: Type.Object(
      {
        project: Type.String({ minLength: 1, description: "Relative to the project." }),
        user: Type.Object(
          {
            default: Type.String({ pattern: "^~/.", description: "Under your home folder." }),
            env: Type.Optional(
              Type.String({
                pattern: VARIABLE,
                description: "The variable the harness itself reads to move it.",
              }),
            ),
            within: Type.Optional(
              Type.String({
                minLength: 1,
                description: "The root's path inside the folder `env` names, when not that folder.",
              }),
            ),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    detect: Type.Optional(
      Type.Union([
        Type.Literal("never"),
        Type.Object(
          {
            env: Type.Optional(Type.Array(Type.String({ pattern: VARIABLE }))),
            binary: Type.Optional(Type.Array(Type.String({ pattern: PROGRAM }))),
            paths: Type.Optional(Texts),
            projectRoot: Type.Optional(
              Type.Literal(false, {
                description: "Its project folder is one many repositories hold, so proves nothing.",
              }),
            ),
          },
          { additionalProperties: false },
        ),
      ]),
    ),
    reads: Type.Optional(PerKind(Texts)),
    kinds: PerKind(ref("kind")),
    verified: Type.Optional(
      Type.Object(
        {
          command: Type.Array(Text, {
            minItems: 1,
            prefixItems: [Type.String({ pattern: PROGRAM })],
            description: "The program and its arguments, never run through a shell.",
          }),
          range: Text,
        },
        { additionalProperties: false },
      ),
    ),
    trust: Type.Optional(
      PerKind(
        Type.Object(
          {
            run: Type.String({ minLength: 1, description: "Printed, never run." }),
            scope: Type.Optional(choice("project", "user")),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    instances: Type.Optional(
      Type.Object(
        { root: Type.String({ pattern: "^~/.*\\{profile\\}[^/]*$" }) },
        { additionalProperties: false },
      ),
    ),
    reload: Type.Optional(Text),
  },
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "harness.schema.json",
    $defs: { kind: KindMapping, register: Register, codec: Codec, value: ConfigValue },
    title: "harness file",
    description: "A harness aireg installs into, defined in your user scope.",
    additionalProperties: false,
  },
);
