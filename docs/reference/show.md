# aireg show

Print an artifact without installing it.

## Synopsis

```text
aireg show <registry>/<namespace>/[<kind>/]<name>[@<version>]
aireg show <namespace>/[<kind>/]<name>[@<version>] --registry <registry>
aireg show ./<path>
```

## Description

`aireg show` prints an artifact's Markdown, such as a skill's `SKILL.md`, so you can read it before you install it. It installs nothing and doesn't change the manifest. Terminal control characters in the file are removed, with a warning; `--json` keeps them.

A plugin can carry more than instructions: hooks, MCP servers, LSP servers, monitors and executables in `bin/`, which a coding agent starts by itself and runs as you. When an artifact carries any of these, `show` names them in a warning, and `add`, `install` and `update` name them after installing it. Read what such a plugin runs before you install it, and know that an update can add to it.

Name an artifact by its full name, `<registry>/<namespace>/<name>`. Add `@<version>` to read an older version.

To read from a registry without declaring it first, give its address with `--registry` and write the rest of the full name on its own: `aireg show engineering/pr-review --registry github.com/acme/ai-registry`.

A path that starts with `./`, `../`, `/` or `~/` is read from disk. For a folder, `show` prints its `SKILL.md`, else its `AGENT.md`, else its `README.md`, else its first Markdown file, and does the same for an artifact that is a folder.

## Options

| Option | Description |
|---|---|
| `-r`, `--registry <registry>` | The registry to read from, by name or address. The artifact is then named by the part of its full name after the registry. |
| `--ref <ref>` | For a git registry, the branch, tag or commit to read. |
| `--path <folder>` | For a git registry, the folder in the repository that holds the registry. |
| `--adapter <id>` | The adapter that reads the registry, when aireg can't tell from the address. |
| `--layout <layout>` | How to read the source, `registry`, `marketplace`, `well-known` or `folder`, instead of telling from what it holds. |
| `--config <key>=<value>` | A setting for that adapter. Repeat it for more than one. A setting the adapter doesn't take is refused: git takes `ref` and `path`, and a local folder takes none. |

`show` also takes `-g`, to look up registry names in your user scope only. See [Command options](options.md#command-options).

## JSON output

For an artifact:

```json
{"ok": true, "data": {"name": "pr-review", "kind": "skill", "version": "1.2.0", "body": "---\nname: pr-review\n...", "carries": []}}
```

For a path on disk, `data` holds `path`, `body` and `carries`. `carries` lists what a coding agent would start from the artifact, by the plugin manifest key that declares each: `hooks`, `mcpServers`, `lspServers` and `monitors`, and `bin` for a `bin/` folder.

## Exit status

- `0`: printed.
- `1`: the registry or artifact doesn't exist, or the path holds no Markdown.
- `2`: nothing was named, the name is a registry or a namespace rather than an artifact, or matches more than one artifact.

## Examples

Read a skill before installing it:

```bash
aireg show acme/engineering/pr-review
```

Read a skill you're writing:

```bash
aireg show ./skills/draft-skill
```

## See also

[`aireg add`](add.md), [`aireg registry show`](registry.md#aireg-registry-show), [CLI reference](index.md)
