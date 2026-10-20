import { Type } from "@sinclair/typebox";
import { LAYOUT_IDS, type LayoutId } from "#adapter/layouts/ids.ts";
import { DEFAULT_TARGETS } from "#core/harness/index.ts";

/** The shape of `manifest.yml`. The parser stays the authority on what is accepted. */

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

/** An address; only one artifact, three segments or more, may carry `@<version>`: a version token as `adapter/spec/ref.ts` reads it. */
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
    harnesses: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: "Harnesses this entry projects into, narrowing the manifest's `harnesses:`.",
      }),
    ),
    copy: Type.Optional(
      Type.Boolean({
        description:
          "Copy into each harness folder rather than linking, as `aireg add --copy` records.",
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
  { additionalProperties: false },
);

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
    harnesses: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: `Harnesses to install into, by name. Absent or empty means ${DEFAULT_TARGETS.join(" and ")}.`,
      }),
    ),
    registries: Type.Optional(
      Type.Record(Type.String(), AnyRegistry, {
        description: "Where artifacts come from, keyed by the alias a reference uses.",
      }),
    ),
    artifacts: Type.Optional(
      Type.Array(Type.Union([Reference, DetailedReference]), {
        description:
          "A string reference, or `{ ref, as, exclude, harnesses, copy, trust }` to rename it, leave members out, narrow where it lands, copy it rather than link it, or trust a plugin it brings.",
      }),
    ),
  },
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "manifest.schema.json",
    title: "manifest.yml",
    description:
      "A project's manifest: the registries it installs from, the artifacts it wants, and the harnesses it projects into. Where this schema and the CLI disagree, the CLI is authoritative.",
    additionalProperties: false,
  },
);
