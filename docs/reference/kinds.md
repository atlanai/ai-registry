# aireg skill and aireg agent

Create a skill or an agent, or start its next version.

## Synopsis

```text
aireg skill new [<name>] [--namespace <namespace>] [--set <key>=<value>]... [-y]
aireg skill new --from <path>... [--name <name>] [--namespace <namespace>] [-y]
aireg skill bump <name> [patch | minor | major | <version>] [--namespace <namespace>]
```

`aireg agent` takes the same actions.

## Description

aireg has one command for each kind of artifact. `skill` and `agent` are always there. In a registry whose `registry.json` lists its kinds, the commands are those kinds instead. A kind named like one of aireg's own commands, such as `status`, gets no command of its own, and aireg warns about it.

### new

`new` creates an artifact with every field its kind requires. On a terminal, aireg asks for the fields it can't fill in, such as the description. Any it doesn't get are set to `TODO`, and `new` lists them, so you know what to write.

- **In a registry**, it creates version `0.1.0` in `artifacts/<namespace>/<kind>/<name>/0.1.0/`. The namespace is `--namespace`, or the `artifacts/<namespace>/` folder you're in, or on a terminal aireg asks. Without `<name>`, aireg asks for it on a terminal.
- **Outside a registry**, it creates `./<name>/`, ready to publish with [`aireg publish`](publish.md). Publish a skill by its folder, and an agent by the path to its `AGENT.md`, since `publish` takes an agent as a single file.

A skill gets a `SKILL.md`. An agent gets an `AGENT.md`, or an `agent-card.json` with `--file agent-card.json`. A card's `name`, `description` and `runtime` are what `registry index` checks, so a card aireg writes indexes as it is.

### new --from

`new --from` copies skills or agents you already have into the registry as version `0.1.0`. It checks each one first, and copies nothing if any of them isn't valid. The originals are left where they are.

To copy in an agent, `--from` needs an `AGENT.md` or `agent-card.json` that sets `runtime.harness`. A coding agent's own agent file, such as `.claude/agents/reviewer.md`, doesn't have that field and isn't accepted.

### bump

`bump` starts an artifact's next version by copying its newest version folder, such as `1.2.0` to `1.3.0` for `minor`. Edit the copy, then run [`aireg registry index`](registry.md#aireg-registry-index) to release it. It defaults to `patch`.

### Dependencies

An artifact names what has to be installed with it as `depends_on` relationships in its version's `artifact.json`, each a `<namespace>/<kind>/<name>@<version>` in the same registry, as the [file spec](https://github.com/atlanai/ai-registry/blob/main/spec/file-spec.md) describes. Write the file in the new version folder before [`aireg registry index`](registry.md#aireg-registry-index), which keeps what it says:

```json
{ "relationships": [{ "rel_type": "depends_on", "to": "engineering/skill/pr-review@0.2.0" }] }
```

[`aireg add`](add.md) installs them. `bump` carries the last version's dependencies into the new one, so move the versions they name when you release new ones.

## Options

| Option | Description |
|---|---|
| `--namespace <namespace>` | The namespace in the registry, in lowercase letters, digits and hyphens. |
| `--set <key>=<value>` | A field to fill in. Use dots for nested fields, such as `--set runtime.harness=claude`. Repeat it for more than one. |
| `--file <file>` | For a kind that offers more than one layout, the file to create, such as `agent-card.json` for an agent. |
| `--from <path>` | An existing skill folder or agent file to copy in. Repeat it, or list more paths after it. |
| `--name <name>` | With `--from`, the name to give the one artifact copied in. |
| `-y`, `--yes` | Don't ask for the namespace, the name or the fields. |

## JSON output

```json
{"ok": true, "data": {"kind": "skill", "name": "pr-review", "created": ["artifacts/engineering/skill/pr-review/0.1.0/SKILL.md"], "todo": ["description"]}}
```

`new --from` prints the kind, the namespace and where each artifact was copied. `bump` prints the kind, the name, and the versions it copied `from` and `to`.

## Exit status

- `0`: created or copied, or canceled at a question.
- `1`: the artifact or version already exists, a path is missing or isn't a valid skill or agent, or there is no version to start from.
- `2`: the action, namespace, name or version isn't valid, a namespace or, in a registry, a name is missing and aireg can't ask, or `--from` or `bump` is run outside a registry.

## Examples

Create a skill in a registry's `engineering` namespace:

```bash
aireg skill new pr-review --namespace engineering
```

Bring in skills you already use:

```bash
aireg skill new --from ~/.claude/skills/pr-review ~/.claude/skills/lint --namespace engineering
```

Start the next minor version of a skill, then release it:

```bash
aireg skill bump pr-review minor --namespace engineering
aireg registry index
```

## See also

[`aireg registry`](registry.md), [`aireg publish`](publish.md), [CLI reference](index.md)
