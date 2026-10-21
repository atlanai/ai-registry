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
- **Outside a registry**, it creates `./<name>/`, ready to publish with [`aireg publish`](publish.md). Publish a skill by its folder, and an agent by its folder or the path to its `AGENT.md`. An agent's folder may hold other files beside its `AGENT.md`, which `publish` sends with it as a [folder agent](publish.md#folder-agents).

A skill gets a `SKILL.md`. An agent gets an `AGENT.md`, or an `agent-card.json` with `--file agent-card.json`. Exactly one agent entry file must be present. Other files may sit beside it, such as the files a folder agent works from; a registry folder keeps them in the version folder, and a project installs the agent as its entry file alone, since each coding agent takes an agent as one file. The card keeps its human-readable `name`; the registry folder supplies the slug in the envelope's `spec.name`. `spec.card` preserves the card and `spec.description` copies its description. Card content is otherwise opaque to this kind schema; this is not full A2A protocol validation. Which coding agents install an agent is up to each project, so aireg never asks for it.

Native `AGENT.md` front matter can include fields such as `tools`, `model` and tool-specific
extensions. These fields are preserved. Skill front matter remains limited to the Agent Skills
fields; skill names cannot contain consecutive hyphens, and `compatibility`, if present, must
contain 1–500 characters. Character limits count Unicode code points.

Supporting README and JSON files are allowed, but never supply a built-in kind's identity or
replace its native entry. `--file` must name an advertised file alternative; if a custom kind
also has shared required files, those are created with the selected alternative.

### new --from

`new --from` copies skills or agents you already have into the registry as version `0.1.0`. It checks each one first, and copies nothing if any of them isn't valid. The originals are left where they are.

To copy in an agent, `--from` takes a folder that holds an `AGENT.md` or an `agent-card.json`. To bring in a coding agent's own file, such as `.claude/agents/reviewer.md`, [publish](publish.md) it into the registry folder, which copies it in as `AGENT.md` as it is.

For a card named `Recipe Agent`, import derives the registry slug `recipe-agent`. Pass
`--name recipe-helper` to choose a different slug. Both choices leave the card bytes unchanged.
The normal artifact-name and collision checks apply.

### bump

`bump` starts an artifact's next version by copying its newest version folder, such as `1.2.0` to `1.3.0` for `minor`. Edit the copy, then run [`aireg registry index`](registry.md#aireg-registry-index) to release it. It defaults to `patch`.

### Dependencies

An artifact names what has to be installed with it as `depends_on` relationships in its version's `artifact.json`, each a `<namespace>/<kind>/<name>@<version>` in the same registry unless the edge names another, as the [file spec](https://github.com/atlanai/ai-registry/blob/main/spec/file-spec.md) describes. Write the file in the new version folder before [`aireg registry index`](registry.md#aireg-registry-index), which keeps what it says:

```json
{ "relationships": [{ "rel_type": "depends_on", "to": "engineering/skill/pr-review@0.2.0" }] }
```

An edge may also carry `range`, the versions of that artifact it accepts, as a version range the file spec defines, such as `^0.2.0` or `>=0.2.0 <0.4.0`. The version `to` names has to be in its own range, or aireg leaves the edge out with a warning:

```json
{ "relationships": [{ "rel_type": "depends_on", "to": "engineering/skill/pr-review@0.2.0", "range": "^0.2.0" }] }
```

An edge may name another registry by its canonical address, the `url` in that registry's `registry.json`, in `registry`:

```json
{ "relationships": [{ "rel_type": "depends_on", "to": "platform/skill/sql-style@1.2.0", "range": "^1.2.0", "registry": "https://github.com/acme/agent-registry" }] }
```

aireg installs it from the registry the project declares at that address, under that registry's name in the lockfile. A declared registry has the address it was declared at, written as `https://<host>/<path>` with no trailing `/` or `.git`, so `github.com/acme/agent-registry` matches. What a registry's own `registry.json` says it is counts only for a registry declared at an address with no such form, such as a folder: there its `https` `url` is its address, and the lockfile records it, so the next run need not read the folder to know it. aireg never declares a registry because an edge names it: when no declared registry has that address, `add` installs nothing and names the [`aireg registry add`](registry.md#aireg-registry-add) that would allow it. When two or more have it, `add` installs nothing and names them, so you can keep one. An aireg older than this field looks for `to` in the artifact's own registry, so don't publish an edge with `registry` whose `to` that registry also holds.

[`aireg add`](add.md) installs them. An edge without a range installs the version it names. An edge with one installs the newest version in the range that installs without a pin. Where several artifacts need one dependency, it installs once, at the newest version every edge accepts; when no version could satisfy them all, the registry publishes none that does, or what they all accept takes more than the 256 characters a range may have, `add` installs nothing and names each range and the artifact it came from. A prerelease counts as accepted only when every range admits it. The lockfile records each range, and [`aireg update`](update.md) moves the dependency to the newest version that every range still accepts. `bump` carries the last version's dependencies into the new one, so move the versions they name when you release new ones.

To write these edges from the project where the artifacts are made, rather than by hand in the registry, list them as `depends_on` in the project's `exports:`, and [`aireg publish`](publish.md#dependencies) writes each one into the version it publishes. A project that installs that repository itself, rather than a registry it publishes to, gets the same dependencies from its manifest; see [Sources that are not registries](add.md#sources-that-are-not-registries).

### Version status

Each version in `versions.json` has a status, which you change by hand and then run [`aireg registry index`](registry.md#aireg-registry-index). `add`, `install`, `update` and background jobs act on it:

| Status | What aireg does |
|---|---|
| `active` | Installs it. |
| `deprecated` | Installs it, with a warning that gives the version's `reason`. |
| `draft`, `pending_review` | Never picks it as the newest version, or with a whole namespace or registry. Installs it only when you pin it, with a warning. |
| `blocked` | Never installs it, even pinned, and says why. A copy already installed stays, and `update` names the `aireg remove` that takes it out. |
| `archived` | Installs it only when you name the artifact, not with its namespace or registry. |

## Options

| Option | Description |
|---|---|
| `--namespace <namespace>` | The namespace in the registry, in lowercase letters, digits and hyphens. |
| `--set <key>=<value>` | A field to fill in. Use dots for nested fields, such as `--set metadata.category=engineering`. Repeat it for more than one. |
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
