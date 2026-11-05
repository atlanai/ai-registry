import { Type } from "@sinclair/typebox";
import { LAYOUT_IDS, type LayoutId } from "#adapter/layouts/ids.ts";
import { LEGACY_TARGETS_KEY } from "#core/manifest/model.ts";
import { DEFAULT_TARGETS } from "#core/target/ids.ts";

/** `harnesses`, as aireg 0.1 spells `targets`, which aireg still writes so that version reads it. */
const Legacy = (minItems: number) =>
  Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      ...(minItems > 0 ? { minItems } : {}),
      description:
        "`targets` by the name aireg 0.1 reads, which aireg writes unless the manifest says `targets`.",
    }),
  );

/** A list said under both names is ambiguous, so the parser refuses it. */
const ONE_TARGETS_KEY = {
  not: {
    properties: { targets: true, [LEGACY_TARGETS_KEY]: true },
    required: ["targets", LEGACY_TARGETS_KEY],
  },
};

/** What each layout reads, which an editor shows beside the value it offers. */
const LAYOUT_READS: Record<LayoutId, string> = {
  registry: "A registry laid out as the file spec describes, with a `registry.json` at its root.",
  marketplace:
    "A plugin marketplace, `.claude-plugin/marketplace.json` or else `.agents/plugins/marketplace.json`, or one plugin with its own manifest: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` or an Agent Plugins `plugin.json`.",
  "well-known":
    "A site's Agent Skills discovery index, `/.well-known/agent-skills/index.json` in the 0.2.0 format, whose skills are `SKILL.md` files or `.tar.gz` and `.zip` archives.",
  folder:
    "Skills as folders holding a `SKILL.md`, up to three levels down, and agents as `*.md` files in `agents/` or `.claude/agents/`.",
};

const Registry = Type.Object(
  {
    source: Type.String({
      minLength: 1,
      description: "The address: a repository, a directory on this machine, or a registry URL.",
    }),
    adapter: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Which adapter reads it. Omit to let the address decide.",
      }),
    ),
    ref: Type.Optional(
      Type.String({
        minLength: 1,
        description: "A tag, a branch, or a full commit id. What it means is the adapter's to say.",
      }),
    ),
    path: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "The folder inside the source that holds the registry, when it is not the root.",
      }),
    ),
    layout: Type.Optional(
      Type.Union(
        LAYOUT_IDS.map((id) => Type.Literal(id, { description: LAYOUT_READS[id] })),
        {
          description:
            "How the source lays out what it holds, which aireg records the first time it reads one that is not a registry.",
        },
      ),
    ),
    config: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 }), {
        description: "Adapter-defined scope selection, such as a workspace.",
      }),
    ),
  },
  { additionalProperties: false },
);

const AnyRegistry = Type.Union(
  [
    Type.String({
      minLength: 1,
      description: "Shorthand for an address with nothing else to say.",
    }),
    Registry,
  ],
  { description: "One address, and whatever the adapter reading it needs to know." },
);

/** Only an address of three or more segments may carry `@<version>`; see `adapter/spec/ref.ts`. */
const REFERENCE =
  "^[^@\\\\/]+(/[^@\\\\/]+)*$|^[^@\\\\/]+(/[^@\\\\/]+){2,}@[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$";

const Reference = Type.String({
  minLength: 1,
  pattern: REFERENCE,
  description: "An address, such as acme/platform or acme/platform/skill/lint@1.2.0.",
});

const DetailedReference = Type.Object(
  {
    ref: Type.String({
      minLength: 1,
      pattern: REFERENCE,
      description: "Any reference a string entry takes.",
    }),
    as: Type.Optional(
      Type.String({
        minLength: 1,
        pattern: "^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$",
        description: "Unique local name used when remote artifacts collide. One artifact only.",
      }),
    ),
    exclude: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description:
          "Members a whole registry or namespace leaves out, relative to `ref`, such as `skill/lint`.",
      }),
    ),
    targets: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: "Targets this entry projects into, narrowing the manifest's `targets:`.",
      }),
    ),
    [LEGACY_TARGETS_KEY]: Legacy(1),
    copy: Type.Optional(
      Type.Boolean({
        description:
          "Copy into each target folder rather than linking, as `aireg add --copy` records.",
      }),
    ),
    trust: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description:
          "Plugins, by name, allowed to install with the hooks, servers or executables they carry, as `aireg add --trust` records.",
      }),
    ),
  },
  { additionalProperties: false, ...ONE_TARGETS_KEY },
);

const PATH = String.raw`(?![A-Za-z]:)(?!(?:[^/]*/)*\.\.?(?:/|$))[^/\\]+(?:/[^/\\]+)*`;

const ONE_PATH = String.raw`(?![^*?[\]{}]*[*?[\]{}])${PATH}`;

const NAMESPACE = "[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?";

const Target = Type.String({
  pattern: `^[^./][^/]*/${NAMESPACE}$|^(\\.[^/]*)?(/.*)?/${NAMESPACE}$`,
  description:
    "Where exports are published, as `aireg publish --to` takes it: a declared registry and a namespace, such as acme/engineering, or a registry folder and a namespace, such as ./registry/engineering.",
});

const SEMVER_IDENT = String.raw`(0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;

const DetailedExport = Type.Object(
  {
    path: Type.String({
      pattern: `^${ONE_PATH}$`,
      description:
        "One path relative to the project: an artifact, such as .claude/agents/reviewer.md, or a folder, whose artifacts directly inside it are each exported.",
    }),
    kind: Type.Optional(
      Type.Union([Type.Literal("skill"), Type.Literal("agent")], {
        description: "When set, every artifact the entry reaches must be this kind.",
      }),
    ),
    version: Type.Optional(
      Type.String({
        pattern: String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-${SEMVER_IDENT}(\.${SEMVER_IDENT})*)?$`,
        description: "The exact version to publish it at, such as 2.0.0.",
      }),
    ),
    depends_on: Type.Optional(
      Type.Array(
        Type.String({
          pattern: String.raw`^\./${ONE_PATH}$|^[^@\\/]+(/[^@\\/]+){3}$`,
          description:
            "An artifact in the project, or a folder of them, as ./ and its path, which is exported with it, or an artifact listed under `artifacts:`, as <registry>/<namespace>/<kind>/<name> with no version.",
        }),
        { uniqueItems: true, description: "What it needs installed beside it." },
      ),
    ),
    publish: Type.Optional(
      Type.Literal(false, {
        description: "`false` keeps it in this repository; absent, it goes to `publish.to`.",
      }),
    ),
    exclude: Type.Optional(
      Type.Array(Type.String({ pattern: String.raw`^(?!\.\.?$)[^/\\*?[\]{}]+$` }), {
        uniqueItems: true,
        description:
          "For a folder of artifacts: the names of what is directly inside it that it does not export.",
      }),
    ),
    ignore: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        uniqueItems: true,
        description:
          "Gitignore patterns, relative to each artifact the entry reaches: the files left out. The entry file always goes.",
      }),
    ),
    include: Type.Optional(
      Type.Array(
        Type.Union([
          Type.String({
            pattern: `^${ONE_PATH}$`,
            description: "A file or folder relative to the artifact, stored at the same path.",
          }),
          Type.Object(
            {
              from: Type.String({
                pattern: `^${ONE_PATH}$`,
                description: "A file or folder relative to the artifact.",
              }),
              as: Type.String({
                pattern: `^${ONE_PATH}$`,
                description: "The path it is stored at in the published version.",
              }),
            },
            { additionalProperties: false },
          ),
        ]),
        {
          description:
            "The only files each artifact the entry reaches publishes, besides its entry file, which always goes: a path, or `{ from, as }` to store one at another path.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

const AnyExport = Type.Union(
  [
    Type.String({
      pattern: `^${PATH}$`,
      description:
        "A path relative to the project, or a glob over paths, such as .claude/skills/*.",
    }),
    DetailedExport,
  ],
  { description: "One path, or one path and what to publish it with." },
);

/** The shape of `manifest.yml`. The parser stays the authority on what is accepted. */
export const Manifest = Type.Object(
  {
    $schema: Type.Optional(
      Type.String({ description: "Ignored by the CLI; lets an editor find this schema." }),
    ),
    name: Type.Optional(
      Type.String({ description: "This project's name. Shown in output; never resolved." }),
    ),
    description: Type.Optional(Type.String()),
    engines: Type.Optional(
      Type.Object(
        {
          aireg: Type.Optional(
            Type.String({
              pattern: "^\\d+\\.\\d+\\.\\d+$",
              description:
                "Oldest aireg CLI that can read this file. A plain SemVer, meaning this version or newer.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    targets: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: `Targets to install into, by name. Absent or empty means ${DEFAULT_TARGETS.join(" and ")}.`,
      }),
    ),
    [LEGACY_TARGETS_KEY]: Legacy(0),
    registries: Type.Optional(
      Type.Record(Type.String(), AnyRegistry, {
        description: "Where artifacts come from, keyed by the alias a reference uses.",
      }),
    ),
    artifacts: Type.Optional(
      Type.Array(Type.Union([Reference, DetailedReference]), {
        description:
          "A string reference, or `{ ref, as, exclude, targets, copy, trust }` to rename it, leave members out, narrow where it lands, copy it rather than link it, or trust a plugin it brings.",
      }),
    ),
    exports: Type.Optional(
      Type.Array(AnyExport, {
        description:
          "What this project makes for others to install: a path, such as an artifact or a folder of them, or a glob, or `{ path, kind, version, depends_on, publish, exclude, ignore, include }` to give one path a kind it must be, an exact version, dependencies, `publish: false` to keep it here, or the files it publishes.",
      }),
    ),
    publish: Type.Optional(
      Type.Object(
        {
          to: Target,
        },
        { additionalProperties: false },
      ),
    ),
  },
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "manifest.schema.json",
    title: "manifest.yml",
    description:
      "A project's manifest: the registries it installs from, the artifacts it wants, and the targets it projects into. Where this schema and the CLI disagree, the CLI is authoritative.",
    additionalProperties: false,
    ...ONE_TARGETS_KEY,
  },
);
