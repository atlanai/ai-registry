# Schemas

JSON Schema 2020-12 documents for the files the CLI reads and writes in a project.
Generated - edit the definitions under [`scripts/schema/`](../scripts/schema), then
run `pnpm run schema`. A test fails if these drift from them.

## Which schema covers what

| Schema | Document |
|---|---|
| [manifest.schema.json](manifest.schema.json) | `.registry/manifest.yml`, what a scope asks for |
| [lockfile.schema.json](lockfile.schema.json) | `.registry/manifest.lock.yml`, what it resolved to |
| [harness.schema.json](harness.schema.json) | `~/.aireg/harnesses/<id>.json`, a harness of your own |
| [kinds/agent.json](kinds/agent.json), [kinds/skill.json](kinds/skill.json) | Copies of the file spec's kind manifests in [`spec/schemas/kinds`](../../spec/schemas/kinds), which the CLI bundles; edit the spec's copy |

These describe the CLI's own files. The registry documents an artifact is
published as - `registry.json`, `index.json`, `versions.json`, `artifact.json` -
are the file spec's, and their schemas live in [`spec/schemas`](../../spec/schemas).

## Policies

**The parser is authoritative, not the schema.** These exist so an editor can
complete and validate the files; where the two disagree, the CLI is right. A
test cross-checks the schema's top-level keys against the parser's own lists,
so the two cannot drift silently.

**Every document closes its objects.** Unlike the file spec's schemas, which
must stay open because readers ignore unknown fields, an unknown key in
`manifest.yml` is a typo the CLI refuses. The schema says the same.

**`$id`s are relative, and are identifiers rather than locations.** Following
the file spec's schemas, nothing dereferences one over the network.

## Using one

aireg does not install them, so point an editor at the copy in this repository:

```yaml
# .registry/manifest.yml
$schema: https://raw.githubusercontent.com/atlanai/ai-registry/main/cli/schema/manifest.schema.json
```

The CLI ignores `$schema` when it reads the file.
