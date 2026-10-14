# Schemas

JSON Schema 2020-12 documents for the file spec's documents. Non-normative index; the schemas
themselves and [file-spec.md](../file-spec.md) are the contract.

## Which schema covers what

| Schema | Document | File spec |
|---|---|---|
| [registry.schema.json](registry.schema.json) | `registry.json` at a root | §3.1 |
| [index.schema.json](index.schema.json) | `index.json` at a root | §3.2 |
| [versions.schema.json](versions.schema.json) | `artifacts/<ns>/<kind>/<name>/versions.json` | §3.3 |
| [artifact.schema.json](artifact.schema.json) | `<version>/artifact.json`, `spec` opaque | §3.4 |
| [artifact-known-kinds.schema.json](artifact-known-kinds.schema.json) | the same envelope with the kind manifests applied to `spec` | §3.4 |
| [file-descriptor.schema.json](file-descriptor.schema.json) | one `files[]` entry | §2.3, §3.5, §4.1 |
| [relationship.schema.json](relationship.schema.json) | one `relationships[]` edge | §3.4, §4.3, §6 |
| [host.schema.json](host.schema.json) | the host document at `/.well-known/registry.json` | §8 |
| [kind-manifest.schema.json](kind-manifest.schema.json) | what `kinds[].manifest_url` points at | §3.1 |
| [kinds/skill.json](kinds/skill.json), [kinds/agent.json](kinds/agent.json) | the `spec` of those kinds | §3.4 |
| [common.schema.json](common.schema.json) | shared `$defs`; never instantiated | §2.1, §4 |

An envelope is validated against **both** artifact schemas on purpose. The plain one is the
reader's contract, where `spec` is opaque. The known-kinds one is the writer's contract, where the
kind manifest applies. A failure in each is a different bug.

## Policies

**No document schema closes its object.** File spec §5 rule 4 requires readers to ignore unknown
envelope fields, unknown kinds, unknown `spec` content, and unknown root entries. A document schema
with `additionalProperties: false` would contradict the specification it describes, so none has one.
A kind manifest chooses its own policy for `spec`. The skill schema is closed; the agent schema
preserves additional native front-matter fields. Writers validate against that policy at publish.

**`$id`s are relative, and are identifiers rather than locations.** A schema's `$id` is the path it
sits at under this directory, and every `$ref` is a relative path resolved the same way. Nothing
dereferences an `$id` over the network, so a validator preloads this directory into a resolver
rather than fetching `$ref`s. No schema file is covered by a content digest or a catalog digest, so
giving the `$id`s an absolute base later moves no digest.

**Schemas are normative for shape; prose is normative for meaning.** The rules a schema cannot state
live in file-spec.md and are enforced by [`tools/check.py`](../../tools/check.py):

- `index.json` entries unique on `(namespace, kind, name)`, and agreeing with the versions documents.
- `versions.json` `latest` naming a listed version, and the newest active one.
- `metadata.namespace`, `metadata.name`, `metadata.version` and the top-level `kind` equalling the
  path segments the envelope sits under.
- The content digest (§4.2) and the catalog digest (§4.3).
- `files[]` digests and sizes matching the bytes, and the path rules of §2.3. Most of those are also
  in `file-descriptor.schema.json` as a lookahead pattern, which RE2-based validators reject; the
  HFS+ code points and case-insensitive collisions are not.
- `registry.json` advertising `files`. The schema does not require it: §3.1 states what a file root
  advertises rather than mandating it, and encoding it here would tighten the specification.

## Kind validation in aireg

The CLI validates locally served manifests against both `kind-manifest.schema.json` and the
Draft 2020-12 meta-schema, then compiles their validation rules with Ajv. Relative `$id`s are
rooted at the registry, and relative `$ref`s resolve against those identifiers. Referenced schema
files must stay inside the registry and must be regular files, not symlinks. External references
are reported as unresolved; validation never downloads a schema. `format` is an annotation in
the CLI. Validation does not coerce values, insert defaults or remove fields.

For built-in kinds, extraction reads only `SKILL.md`, `AGENT.md` or `agent-card.json`. An agent
must carry exactly one of its two entry files. Optional file patterns are non-exhaustive
conventions; other supporting files are permitted and never replace the native entry.

The CLI enforces exact required file paths and the complete alternatives declared by `one_of`.
It does not enforce file media types or glob requirements. Search and embedding pointers,
relationship-kind restrictions and cardinality, attachment and governance flags, and schema
revision negotiation are annotations the CLI does not implement. Its separate dependency check
still verifies that each `depends_on` target exists. `x-registry-schema-version` is a draft
revision marker, not a guarantee that every later schema accepts every earlier input.

These draft corrections permit native agent extensions and separate A2A names from registry
slugs. They also reject skill names with consecutive hyphens, empty `compatibility`, conflicting
agent entries, and values that violated previously ignored JSON Schema constraints. Existing
released artifacts and digests are not migrated; validation can report previously accepted
invalid content, which must be corrected in a new artifact version.

## Running them

```bash
python3 tools/check_schemas.py
```

Structural checks need only the standard library. Instance validation, over every example
registry under `examples/`, additionally needs
`jsonschema` (`python3 -m pip install -r tools/requirements.txt`); without it that tier reports
itself skipped rather than failing.
