# MCP servers in a registry

A registry publishes the MCP servers its users may run, and a client installs each one into every coding agent's own configuration, with secrets as references and without touching entries it did not write.

!!! note "Status"
    The `mcp_server` kind is a draft in the [file spec](https://github.com/atlanai/ai-registry/blob/main/spec/file-spec.md), section 3.4. aireg does not bundle the kind yet: a registry gets it by listing `mcp_server` in `registry.json` and serving `kinds/mcp_server.json` with `kinds/vendor/mcp/` beside it, copied from the spec, as [acme-registry](https://github.com/atlanai/ai-registry/tree/main/examples/acme-registry) does. There, `aireg mcp_server new`, `bump`, `registry index` and `registry validate` work. aireg does not install, update or remove MCP servers in coding agents: `add` and `show` treat `mcp_server` as a kind they do not know, so a ref to one finds nothing and adding a namespace skips it (file spec section 5, rule 4). Everything under [Installing](#installing) is a proposal.

## Principles

| Principle | What it means |
|---|---|
| Use the standard | A server is described by the MCP Registry's `server.json`, the format the official MCP Registry and the registries built on its API publish. The registry adds nothing to that file. |
| Restrict where it is installed | Which tools to expose, timeouts and input values are set by whoever installs the server, as every coding agent and gateway already does. |
| A server is its command | Agents and admin policies identify a server by its launch command or URL. Names are labels. |
| Secrets are references | A client writes `${ISSUES_TOKEN}` in each agent's syntax and never sees the value. |
| Nothing runs on install | The full command is shown first, and again when it changes. Installing never starts a server. |
| Touch only what we wrote | Every entry a client writes has a receipt. Anything else is left alone. |
| Say what is not enforced | Where an agent cannot apply a rule, the server is left out for that agent, or the client says what stays exposed. |

## The kind

A version folder holds the publisher's `server.json`, byte for byte, and optionally a `README.md`:

```text
artifacts/engineering/mcp_server/issue-tracker/
  versions.json
  1.2.0/
    server.json      # the publisher's, unchanged
    README.md        # optional, documentation only
    artifact.json    # generated
```

The envelope's `spec` wraps `server.json`, parsed and otherwise unchanged:

```json
{
  "name": "issue-tracker",
  "description": "Search, read and update issues in the team's issue tracker.",
  "server": { "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json", "name": "com.example/issue-tracker", "…": "…" }
}
```

`spec.name` is the registry slug and `spec.description` a copy of the server's. The kind manifest is [`kinds/mcp_server.json`](https://github.com/atlanai/ai-registry/blob/main/spec/schemas/kinds/mcp_server.json).

### Why `server.json`

It says where to get a server from a package registry at an exact version, or which remote to connect to, and which of its inputs are secret (`isSecret`), and it is what MCP registries exchange. An MCPB bundle's `manifest.json` also marks sensitive settings, but describes one packaged bundle rather than npm, PyPI, OCI and remote servers alike. Agent configuration formats such as `.mcp.json` describe one install for one agent, with values already filled in, so they are what a client writes, not what a registry stores.

### Why `spec.server` embeds the document

The agent kind embeds an A2A card in `spec.card`, and the semantic model kind proposed in [#232](https://github.com/atlanai/ai-registry/pull/232) embeds its document in `spec.model`. `server.json` follows the same rule, so search, `show` and validation read one document. The cost is a second copy of a file of about a kilobyte. The same rule brings the same limit: section 4.2 forbids non-integer numbers in an envelope, and `_meta` → `io.modelcontextprotocol.registry/publisher-provided` allows any JSON. A `server.json` with `"qualityScore": 4.5` in it cannot be published until it changes. Whatever the project settles for embedding applies to both kinds.

### Why the registry adds no policy

A registry could attach its own decisions to a republished server, such as a tool filter, timeouts or fixed input values. This design does not, because nothing else in the ecosystem puts them in a registry entry:

- The MCP Registry adds only lifecycle data, such as `status` and `publishedAt`, in a `_meta` beside each `server`, and subregistries add annotations such as ratings and scan results. Neither defines tool filters or input values.
- Every coding agent keeps tool filters and timeouts in its own configuration: Codex `enabled_tools` and `disabled_tools`, Gemini CLI `includeTools` and `excludeTools`, OpenCode `tools`, Claude Code permission rules. No client reads them from a registry entry.
- Organizations restrict MCP at two levels: which servers are allowed, through managed settings in Claude Code, Codex, VS Code and Copilot, where registry membership can act as the allowlist; and which tools, through gateways such as Docker's MCP gateway, ToolHive and Kong.

So the registry stores what the publisher wrote, and restricting a server is part of installing it; see [Restricting a server](#restricting-a-server).

### Versions

`metadata.version` is the artifact's version and `spec.server.version` the server's. They should be equal: the artifact holds nothing but the server's own file, so a new artifact version is a new server version.

### Validation

`server.json` is checked against the MCP Registry's own schema, and must carry `$schema` to say which version, as the MCP Registry requires of what it publishes. The schema is copied unchanged into [`kinds/vendor/mcp/`](https://github.com/atlanai/ai-registry/tree/main/spec/schemas/kinds/vendor/mcp) with its sha256 recorded, and the manifest refers to it by relative path, so a registry that serves its kind manifests serves the schema beside them, and no validator downloads anything. The manifest lists the schema versions it takes in an `enum` on `server.$schema`, with one `if`/`then` per version. A new MCP schema version is one more file and one more branch, not a change to the file spec.

The MCP schema is JSON Schema draft-07. A 2020-12 validator such as Python's `jsonschema` applies a resource by its own `$schema`. Ajv cannot mix dialects, so aireg registers the draft-07 meta-schema and applies 2020-12 semantics, which give the same answers for every keyword the 2025-12-11 schema uses. `tools/check_schemas.py` fails on a vendored draft-07 copy that uses a keyword whose meaning changed.

## Restricting a server

!!! warning "Proposal"
    Nothing in this section is implemented.

A project that installs a server can narrow it in its manifest, next to the server's entry:

```yaml
mcp_servers:
  issue-tracker:
    tools: { deny: [delete_issue] }
    timeouts: { startup_ms: 20000, tool_ms: 60000 }
    with: { tenant: acme }
```

| Field | Meaning |
|---|---|
| `tools.allow` | Only these tools, by exact MCP tool name. Absent means every tool not denied. |
| `tools.deny` | Never these tools. Deny wins over allow. |
| `timeouts.startup_ms`, `timeouts.tool_ms` | Passed to agents that support them, rounded up to the agent's unit. |
| `with` | Values for non-secret inputs, keyed as described under [Inputs](#inputs). |

Each field maps to what agents already support: Codex has `enabled_tools`, `disabled_tools` and both timeouts; Gemini CLI has `includeTools`, `excludeTools` and `timeout`. Auto-approval is deliberately absent: approving tool calls without asking is a decision for each organization's agent policy.

A tool filter is not a sandbox. The server still holds its credentials, a new server version can add or rename tools, and an agent can be configured around the filter. Use it to keep tools out of the way, and use the credential's scope to limit what the server can do.

## Inputs

`server.json` declares inputs in several places; the example in acme-registry uses environment variables, a header, a remote URL variable and a template variable:

| Input | Declared in | Named by |
|---|---|---|
| Environment variable | `packages[].environmentVariables[]` | `name` |
| Named argument | `packages[].runtimeArguments[]`, `packageArguments[]` | `name`, such as `--port` |
| Positional argument | the same lists, `type: "positional"` | `valueHint` |
| Header | `remotes[].headers[]`, `packages[].transport.headers[]` | `name` |
| Remote URL variable | `remotes[].variables` | its key, such as `tenant` in `https://{tenant}.issues.example.com/mcp` |
| Template variable | any input's `variables` | its key, such as `token` in `Bearer {token}` |

A project's `with` uses these names. One name applies to every input declared under it, in every package and remote. A client resolves each non-secret input it needs from, in order:

1. its fixed `value` in `server.json`;
2. a value the project supplies (`with: { tenant: acme }`, or `--set tenant=acme`);
3. its `default`.

A required input still without a value leaves the server out, with the reason. A secret takes its value only from the environment, even when `server.json` gives it a `value` or `default`: it becomes a reference to an environment variable, in the agent's own syntax.

A secret inside a template needs a rule per agent. `Authorization: Bearer {token}` can be written for Claude Code and Cursor as `Bearer ${TOKEN}` and `Bearer ${env:TOKEN}`, and for Codex as `bearer_token_env_var`. A header such as `X-Auth: key={key}` has no Codex form, since `env_http_headers` maps a header to the whole value of a variable, so Codex is left out for that server, with the reason.

## Installing

!!! warning "Proposal"
    Nothing in this section is implemented.

### Resolving

A client resolves a server into one transport-neutral entry before it writes any agent's file: `stdio` with `command`, `args`, `env` and `cwd`, or `streamable-http` or `sse` with `url` and `headers`. This is the server shape of [Agent Plugins](https://agent-plugins.org), which defines it so that "clients map this portable format to their native configuration", and it is the shape a plugin's bundled `mcp.json` already uses. The one thing the client adds is the list of secret variable names, which Agent Plugins has no field for yet.

It uses the first package whose `registryType` it can launch, `npm` with `npx`, `pypi` with `uvx`, `oci` with `docker run -i --rm`, and otherwise the first remote; the person installing can pick a remote instead.

### Names

Three names each do one job:

- The **server name**, `com.example/issue-tracker`, stays in `server.json`.
- The **artifact name**, `issue-tracker`, is the registry slug.
- The **alias**, the key written into each agent's configuration, defaults to the artifact name, matches `^[A-Za-z0-9_-]{1,64}$`, and can be changed per project. A reverse-DNS name would break Codex keys and Claude Code permission rules such as `mcp__alias__tool`. Two aliases that collide are refused, not renamed.

### Per agent

Cells marked *verify* must be settled by a real install before that agent is supported.

| Agent | Project file | Key | Secret reference | Tool filter |
|---|---|---|---|---|
| Claude Code | `.mcp.json` | `mcpServers` | `${VAR}` | `deny`: `permissions.deny` in `.claude/settings.json`. `allow`: none |
| Codex | `.codex/config.toml` | `mcp_servers` | stdio `env_vars`; HTTP `bearer_token_env_var`, `env_http_headers` | `enabled_tools`, `disabled_tools` |
| Cursor | `.cursor/mcp.json` | `mcpServers` | `${env:VAR}` | none |
| Gemini CLI | `.gemini/settings.json` | `mcpServers` | `$VAR` in `env`, *verify* | `includeTools`, `excludeTools` |
| Copilot CLI | `.mcp.json`, shared, *verify* | `mcpServers` | *verify* | `tools` |
| OpenCode | `opencode.json` | `mcp` | `{env:VAR}`; an unset variable becomes empty | `tools` map |
| Grok Build | `.mcp.json`, shared, *verify* | `mcpServers` | *verify* | *verify* |

Transport names differ too: `server.json` says `streamable-http`, Claude Code writes `http`, Gemini CLI `httpUrl`, OpenCode `remote`, and Codex infers it from `url`.

**Tool filters in Claude Code.** `permissions.allow` means "run without asking", not "only these". Rendering `allow: ["search_issues"]` as `mcp__issues__search_issues` would auto-approve that tool and leave every other one available, the opposite of the intent. Allow-only would need every other tool denied by name, which needs the server's tool list, and install never starts the server to get it. So Claude Code cannot apply `tools.allow`: the server is left out for Claude Code unless the project accepts, with a warning, that every tool stays available. `tools.deny` renders as `permissions.deny`, and those rules get receipts like any other entry.

**A file shared by several agents.** Claude Code and Copilot CLI both read `.mcp.json` → `mcpServers.<alias>`. The client renders the entry once per agent and compares them. When they agree, it writes one entry with one receipt that lists every agent it serves. When they differ, for example because Copilot's `tools` filter sits inside the entry, it installs for the agents whose entry matches the first listed agent's, leaves the others out, and reports the install as `partial`.

**Secret names.** By default a secret binds to the environment variable of the same name, because Codex's `env_vars` passes a variable through only under its own name. Two installed servers that both read `GITHUB_TOKEN` would then share one token. The client warns about such a collision across the servers installed in a scope, and lets a project bind a secret to another variable, as in `--env GITHUB_TOKEN=ACME_GITHUB_TOKEN`, which renders as `"GITHUB_TOKEN": "${ACME_GITHUB_TOKEN}"`. An agent that cannot rename, such as Codex for a stdio server, is left out for that server, with the reason.

### Ownership

The lockfile records a receipt for every entry the client writes: the file, the key path in it, the agents it serves, and the sha256 of what was written. This covers permission rules in `.claude/settings.json` as well as server entries.

| Situation | What the client does | Result |
|---|---|---|
| No entry under the alias | Writes it and records a receipt | installed |
| An identical entry it does not own | Records a receipt | adopted |
| A different entry it does not own | Writes nothing, exits non-zero, suggests another alias | conflict |
| An owned entry someone edited | Keeps the edit, warns; `install --force` restores it | kept |
| An agent cannot express a secret, input or tool filter | Leaves that agent out, installs the rest | partial |
| Remove | Deletes only entries that still match their receipts | removed |

Fields that only the agent sets, such as an approval flag, are kept. Adding `entries` to the lockfile changes its format, so the lockfile's format version must change with it: an older aireg that rewrites the lockfile would otherwise drop the receipts it does not know.

Claude Code keeps user-scope servers in `~/.claude.json`, which it rewrites while running. For user scope, the client prints `claude mcp add-json --scope user …` instead of editing the file, and records the receipt as handed off. `status` reads `~/.claude.json` without writing it, and reports the entry as missing, matching or changed. `update` prints the new command, and `remove` prints `claude mcp remove --scope user <alias>`.

### Consent

`show` and `add` print the command or URL and the variables it reads. An update that changes the command, arguments, transport, URL, environment or tool filter asks again; a background sync only reports it. This follows the MCP security best practices, which ask for the untruncated command and explicit approval.

### What is pinned

The digest in the lockfile pins `server.json`. It does not pin what they point to, and the client says so:

- `npx -y @example/issue-tracker-mcp@1.2.0` pins the top-level package only. Its dependencies resolve when the agent starts it. `pypi` with `uvx` behaves the same.
- `fileSha256` is optional except for MCPB. When it is present, the agent or launcher must check it; aireg never downloads the package.
- An `oci` package can name a tag, such as `docker.io/mcp/filesystem:1.0.2`, which can move. The file spec's indexer works offline and does not resolve tags. A registry that needs an immutable image requires an identifier with `@sha256:…` in review, and the client writes the identifier as given.
- Tool definitions are not pinned. A client never starts the server, so it observes no tool list, and any tool names or hashes a publisher declares are declared, not observed.

## Not in this version

- **Registry-side curation,** such as a registry shipping a server with a tool already hidden. No MCP registry or client supports it today; if one is needed, it would be a separate layer the installing client applies, as Codex's marketplace applies its entries' `policy`.
- **Policy export:** turning approved servers into each agent's allowlist, such as Claude Code's managed `allowedMcpServers`, Codex `requirements.toml`, and VS Code and Copilot policies.
- **A Registry API view:** serving a read-only MCP Registry `v0.1` API, so VS Code and Copilot can browse a registry.
- **MCPB bundles.**
- **Running or proxying servers,** which gateways such as ToolHive and Docker's MCP gateway already do.
- **Declared tool lists and hashes,** until a client can observe the tools it would compare them with.

## Relation to other proposals

- [#222](https://github.com/atlanai/ai-registry/pull/222) proposes an `mcp_server` kind with its own server shape in an `mcp.json`. This design replaces it: `server.json` already carries exact package versions and secret markers, and is the format other registries and clients read.
- [#232](https://github.com/atlanai/ai-registry/pull/232) adds the semantic model kind with the same patterns: the native document embedded in `spec`, another project's schema copied under `kinds/vendor/` and reached by a relative `$ref`, and an `enum` plus `if`/`then` per upstream version.

## Open questions

1. **Format-preserving edits.** Keeping comments in JSONC and TOML agent files needs editors that preserve formatting.
2. **Agent Plugins secrets.** When Agent Plugins adds a secrets field, a plugin's bundled servers can ask for a token, and the client's secret list should follow its shape.
3. **Claude Code remote secrets.** Its documentation says credential variables in a remote `url` and `headers` can read as empty. Test before relying on them.
4. **Gemini CLI references.** Whether `env` expands variables must be tested on a real install.
5. **The command name.** Every coding agent names this command `mcp` (`claude mcp`, `codex mcp`, `gemini mcp`), so `aireg mcp` is proposed as the one spelling for the `mcp_server` kind.
