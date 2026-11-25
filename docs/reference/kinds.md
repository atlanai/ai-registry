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

A skill gets a `SKILL.md`. An agent gets an `AGENT.md`, or an `agent-card.json` with `--file agent-card.json`. Exactly one agent entry file must be present. The card keeps its human-readable `name`; the registry folder supplies the slug in the envelope's `spec.name`. `spec.card` preserves the card and `spec.description` copies its description. Card content is otherwise opaque to this kind schema; this is not full A2A protocol validation. Which coding agents install an agent is up to each project, so aireg never asks for it.

Native `AGENT.md` front matter can include fields such as `tools`, `model` and tool-specific
extensions. These fields are preserved. Skill front matter remains limited to the Agent Skills
fields and Claude Code's `disable-model-invocation`; skill names cannot contain consecutive hyphens, and `compatibility`, if present, must
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

### MCP servers

The `mcp_server` kind's command is `aireg mcp`, with the same actions; no other kind can be named `mcp`. A version holds the publisher's MCP Registry [`server.json`](https://github.com/modelcontextprotocol/registry), unchanged, and an optional `README.md` that is only documentation. The catalog's description and display name come from `server.json`.

- `new` writes a `server.json` with the fields it requires, under the newest schema version the kind takes.
- `new --from` takes a folder that holds a `server.json`, checks it against the MCP Registry's schema, and copies it in at the server's own `version`.
- `bump` copies the folder and never edits `server.json`. Replace it with the publisher's new file, whose `version` should match the new one.

`aireg add` installs an MCP server as an entry in each target's config. Installing never starts the server. A secret is written as a reference to an environment variable, such as `${ISSUES_TOKEN}`, never as its value. `aireg show` prints the command or URL a server starts with and the variables it reads. Adding a whole namespace or registry lists its servers and asks first; without a terminal it needs `--yes`.

A manifest entry that names one server can set:

```yaml
artifacts:
  - ref: acme/engineering/issue-tracker
    with: { ISSUES_URL: https://issues.example.com }   # input values, never secrets
    env: { ISSUES_TOKEN: ACME_ISSUES_TOKEN }           # read a secret from another variable
    tools: { deny: [delete_issue] }                    # for targets that can narrow tools
```

| Target | This project | Your user scope |
|---|---|---|
| Claude Code | `.mcp.json` | left out: Claude Code rewrites `~/.claude.json`; use `claude mcp add-json` |
| GitHub Copilot | `.mcp.json`, shared with Claude Code | `~/.copilot/mcp-config.json` |
| Codex | `.codex/config.toml` | `~/.codex/config.toml` |
| Cursor | `.cursor/mcp.json` | `~/.cursor/mcp.json` |
| Gemini CLI | `.gemini/settings.json` | `~/.gemini/settings.json` |
| OpenCode | `opencode.json` | `~/.config/opencode/opencode.json` |
| Grok Build | `.grok/config.toml` | `~/.grok/config.toml` |
| Pi | `.pi/mcp.json` | `~/.pi/agent/mcp.json` |
| Google Antigravity | `.agents/mcp_config.json` | `~/.gemini/config/mcp_config.json` |
| Hermes Agent | left out | `~/.hermes/config.yaml` |

The shared `.agents` folder has no MCP file. A target is left out for a server, with the reason printed, when it cannot express it: a transport it does not load, a secret where it reads none (Codex reads a secret only as a whole variable, Gemini CLI only in `env`, Pi only in `env` and headers, Antigravity nowhere), or `tools` it cannot apply. Codex, Copilot, Gemini CLI, Antigravity and Hermes Agent take the tool lists; Claude Code takes `deny` as `permissions.deny` rules in `.claude/settings.json` and is left out for `allow`; the others are left out when `tools` is set. Targets that share a file, such as Claude Code and Copilot in `.mcp.json`, get the entry only when each takes it the same, tool filter included; otherwise it is left out for all of them. A config file aireg cannot parse, such as JSON with comments, is left as it is.

An entry edited after it was installed is kept, and `aireg status` reports it; one aireg did not write under the same name is left alone, so install the server under another name with `as`.

### Dependencies

An artifact names what has to be installed with it as `depends_on` relationships in its version's `artifact.json`, each a `<namespace>/<kind>/<name>@<version>` in the same registry, as the [file spec](https://github.com/atlanai/ai-registry/blob/main/spec/file-spec.md) describes. Write the file in the new version folder before [`aireg registry index`](registry.md#aireg-registry-index), which keeps what it says:

```json
{ "relationships": [{ "rel_type": "depends_on", "to": "engineering/skill/pr-review@0.2.0" }] }
```

[`aireg add`](add.md) installs them. `bump` carries the last version's dependencies into the new one, so move the versions they name when you release new ones.

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
| `--from <path>` | An existing artifact folder or file to copy in. Repeat it, or list more paths after it. |
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
