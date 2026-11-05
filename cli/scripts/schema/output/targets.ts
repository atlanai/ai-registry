import { type TSchema, Type } from "@sinclair/typebox";
import type { TargetCheck, TargetShown, TargetsList } from "#cli/commands/targets/result.ts";
import type { ConfigValue as Value } from "#core/target/contract.ts";
import { matching, outputDocument } from "./match.ts";

const By = Type.Optional(
  Type.Union(
    [Type.Literal("env"), Type.Literal("binary"), Type.Literal("project"), Type.Literal("user")],
    { description: "The rule that found it; absent when it was not found." },
  ),
);

const Origin = Type.String({ description: "`built-in`, or the path of the file that defines it." });

const EarlierKind = Type.Union(
  [Type.Literal("coding"), Type.Literal("personal"), Type.Literal("shared")],
  { description: "aireg 0.1's name for the category." },
);

const Texts = Type.Array(Type.String());

const List = matching<TargetsList>()(
  Type.Object(
    {
      targets: Type.Array(
        Type.Object(
          {
            name: Type.String(),
            aliases: Texts,
            displayName: Type.String(),
            shared: Type.Boolean(),
            detected: Type.Boolean(),
            by: By,
            origin: Origin,
          },
          { additionalProperties: false },
        ),
      ),
      harnesses: Type.Array(
        Type.Object(
          {
            name: Type.String(),
            displayName: Type.String(),
            kind: EarlierKind,
            shared: Type.Boolean(),
            detected: Type.Boolean(),
            by: By,
            origin: Origin,
          },
          { additionalProperties: false },
        ),
        { description: "The same list as aireg 0.1 printed it, by the ids that version knows." },
      ),
      skipped: Type.Array(
        Type.Object({ path: Type.String(), problems: Texts }, { additionalProperties: false }),
        { description: "Target files aireg refused." },
      ),
      warnings: Type.Array(
        Type.Object({ path: Type.String(), warnings: Texts }, { additionalProperties: false }),
        { description: "Target files aireg uses but would have you change." },
      ),
    },
    { additionalProperties: false },
  ),
);

const ConfigValue = Type.Unsafe<Value>({
  description: "Text, a number, true or false, a list or a table.",
});
const ConfigTable = Type.Record(Type.String(), ConfigValue);

const Codec = Type.Union([
  Type.Object(
    { id: Type.Literal("frontmatter-toml"), fields: Texts, body: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { id: Type.Literal("frontmatter-strict"), keep: Texts, restrictions: Type.Optional(Texts) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: Type.Literal("frontmatter-set"),
      set: ConfigTable,
      restrictions: Type.Optional(Texts),
    },
    { additionalProperties: false },
  ),
]);

const Register = Type.Object(
  {
    file: Type.String(),
    format: Type.Union([Type.Literal("toml"), Type.Literal("json"), Type.Literal("yaml")]),
    at: Texts,
    init: Type.Optional(ConfigTable),
    conflict: Type.Optional(Type.Union([Type.Literal("overwrite"), Type.Literal("keep")])),
    remove: Type.Optional(Type.Union([Type.Literal("ours"), Type.Literal("entry")])),
    off: Type.Optional(ConfigTable),
    value: Type.Optional(ConfigTable),
    upsert: Type.Optional(
      Type.Object({ key: Type.String(), item: ConfigTable }, { additionalProperties: false }),
    ),
    append: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
    description: "One edit to a config file the target reads: `value`, `upsert` or `append`.",
  },
);

const Scope = Type.Optional(Type.Literal("user"));

const KindMapping = Type.Union(
  [
    Type.Object({ shape: Type.Literal("contents") }, { additionalProperties: false }),
    Type.Object(
      {
        shape: Type.Literal("directory"),
        subdir: Type.String(),
        scope: Scope,
        place: Type.Optional(
          Type.Union([Type.Literal("link"), Type.Literal("fan"), Type.Literal("copy")]),
        ),
        entry: Type.Optional(Type.String()),
        manifest: Type.Optional(
          Type.Array(
            Type.Object(
              { path: Type.String(), body: Type.Optional(ConfigTable) },
              { additionalProperties: false },
            ),
          ),
        ),
        register: Type.Optional(Type.Array(Register)),
        codec: Type.Optional(Codec),
        keys: Type.Optional(
          Type.Record(
            Type.String(),
            Type.Union([
              Type.Literal(false),
              Type.Object(
                { path: Type.String(), body: ConfigTable },
                { additionalProperties: false },
              ),
            ]),
          ),
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        shape: Type.Literal("file"),
        subdir: Type.String(),
        extension: Type.String(),
        scope: Scope,
        place: Type.Optional(Type.Union([Type.Literal("link"), Type.Literal("copy")])),
        codec: Type.Optional(Codec),
        render: Type.Optional(
          Type.Object(
            { format: Type.Literal("toml"), fields: Texts, body: Type.String() },
            { additionalProperties: false, description: "Deprecated: the frontmatter-toml codec." },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  ],
  { description: "Where one kind lands inside the target's folder." },
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

/** The fields a resolved target and aireg 0.1's form of it share. */
const resolved = {
  name: Type.String(),
  displayName: Type.String(),
  projectRoot: Type.String(),
  userRoot: Type.String({ description: "Expanded, under your home folder." }),
  envHome: Type.Optional(Type.String({ description: "The variable the target reads to move it." })),
  envWithin: Type.Optional(Type.String()),
  detect: Type.Union([
    Type.Literal("never"),
    Type.Object(
      {
        env: Texts,
        binary: Texts,
        paths: Texts,
        projectRoot: Type.Optional(Type.Literal(false)),
      },
      { additionalProperties: false },
    ),
  ]),
  kinds: PerKind(KindMapping),
  reads: PerKind(Texts),
  shared: Type.Boolean(),
  verified: Type.Optional(
    Type.Object({ command: Texts, range: Type.String() }, { additionalProperties: false }),
  ),
  trust: PerKind(
    Type.Object(
      {
        run: Type.String(),
        scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("user")])),
      },
      { additionalProperties: false, description: "A command a person runs; never run." },
    ),
  ),
  reload: Type.Optional(Type.String()),
  origin: Origin,
};

// A target's fields may hold undefined, which JSON leaves out, so the domain type is declared
// here and the schema states what the JSON carries.
const Show = matching<TargetShown>()(
  Type.Object(
    {
      target: Type.Unsafe<TargetShown["target"]>(
        Type.Object({ ...resolved, aliases: Texts }, { additionalProperties: false }),
      ),
      harness: Type.Unsafe<TargetShown["harness"]>(
        Type.Object(
          { ...resolved, kind: EarlierKind },
          { additionalProperties: false, description: "As aireg 0.1 knew it." },
        ),
      ),
    },
    { additionalProperties: false },
  ),
);

const Check = matching<TargetCheck>()(
  Type.Object(
    {
      path: Type.String(),
      id: Type.Optional(
        Type.String({ description: "Absent when the file defines no usable target." }),
      ),
      problems: Texts,
      warnings: Texts,
    },
    { additionalProperties: false },
  ),
);

export const OUTPUT = outputDocument("targets", { targets: List, show: Show, check: Check });
