# Options

## Global options

These options work with every command. `aireg --help` lists them.

| Option | Description |
|---|---|
| `--json` | Print machine-readable output. See [Output and exit codes](output.md). |
| `--verbose` | Print each step on stderr as it runs. |
| `-q`, `--quiet` | Print only the result, warnings and errors. Can't be combined with `--verbose`. |
| `--color <when>` | Color the output: `auto` (the default), `always` or `never`. See [Color](output.md#color). |
| `--no-color` | The same as `--color never`. Can't be combined with `--color`. |
| `--log-level <level>` | Write diagnostic logs to stderr and to the log file, at `trace`, `debug`, `info`, `warn`, `error` or `fatal`, or `off` for none. Read them with [`aireg logs`](logs.md). |
| `--map [tree|compact|json]` | Print the whole command tree and exit. `tree` is the default. `json` also lists each command's usage and options. |
| `-y`, `--yes` | Take the defaults and ask nothing. A command that asks nothing accepts it too. |
| `-h`, `--help` | Print the help and exit. After a command, print that command's help; `aireg help <command>` does the same. |
| `-v`, `--version` | Print aireg's version and exit. |

`--json`, `--verbose`, `-q`/`--quiet`, `--color`, `--no-color`, `--log-level`, `--map` and `--help` can go anywhere on the line; `--version` goes before the command name. `-y` and the command options go after the command name; aireg refuses one placed before it, with exit status 2.

## Command options

Several commands share these options. Each command's page, and `aireg <command> --help`, lists the ones it takes. A command refuses any other option with exit status 2.

| Option | Description |
|---|---|
| `-g`, `--user` | Act on your user scope (`~/.registry`) instead of the current project. See [Scopes](#scopes). |
| `--for <harness>[,<harness>...]` | The coding agents to install into. Takes a comma-separated list, the option more than once, or `*` for all of them. See [Harnesses](#harnesses). |
| `-s`, `--select <name>` | The artifacts or namespaces to act on. Repeat it, separate names with commas, or pass `*` for everything. |
| `--all` | Act on everything, without asking. The same as `--select '*' --yes`. |
| `--copy` | Copy artifacts into each harness folder instead of linking them. |
| `--dry-run` | Print what would change, then stop without changing anything. |
| `--frozen` | Fail with exit status 3 if the command would change the lockfile or the manifest. `add`, `remove`, `install` and `update` check it. |
| `--force` | Overwrite or remove artifacts that were edited after they were installed. A few commands give it a meaning of their own; their pages say so. |

## Scopes

aireg installs into one of two scopes:

- **The project scope** is the current project. aireg finds it by walking up from the current folder to the nearest folder that holds `.registry/manifest.yml` or a `.git` folder. What the project installs is recorded in `.registry/`, which you commit, so everyone working on the project gets the same artifacts.
- **The user scope** is yours, on this machine, in every project. It lives in `~/.registry`. Pass `-g` to use it.

`install`, `update`, `remove`, `sync` and `unlock` need a project unless you pass `-g`. `add`, `publish`, `registry`, `search`, `show`, `status`, `list` and `outdated` use your user scope when the current folder isn't in a project.

## Harnesses

A harness is a coding agent that aireg installs into. aireg knows five:

| Name | Harness |
|---|---|
| `claude` | Claude Code |
| `codex` | Codex |
| `cursor` | Cursor |
| `copilot` | GitHub Copilot |
| `agents` | The shared `.agents` folder, which several coding agents read. `add` doesn't offer it; choosing one of those agents writes there. |

aireg links each artifact into the folder its harness reads, in a project and in your user scope alike: `.claude/skills/` and `~/.claude/skills/` for Claude Code, for example. Codex reads skills from `.agents/skills/` and `~/.agents/skills/`.

Codex reads agents only as TOML, so aireg writes each one as a file, never a link: `.codex/agents/<name>.toml`, or `$CODEX_HOME/agents/` (default `~/.codex/agents/`) in your user scope. It holds the agent's `name`, `description` and body, as `developer_instructions`; other front matter is left out. Codex loads a project's agents only in a project it trusts.

A plugin installs as one plugin where a harness loads plugins: Claude Code in `.claude/skills/<plugin>/` in a project and `~/.claude/skills/<plugin>/` in your user scope, Codex, in your user scope only, in `~/.codex/plugins/cache/<registry>/<plugin>/local`, which aireg turns on in `~/.codex/config.toml`, and Cursor, in your user scope only, in `~/.cursor/plugins/local/<plugin>/`, as a copy. The same goes, in your user scope, for each namespace of a registry whose adapter declares its namespaces plugins (`namespacePlugins` in the [adapter contract](adapter.md#the-adapter-contract)). Every other harness, and Codex and Cursor in a project, get each skill and agent where they read it, and each command a plugin holds as a skill named `<plugin>-<command>` that only a person invokes.

aireg installs into the harnesses named by `--for`. Without it, aireg uses the `harnesses:` list in the scope's manifest, and without that, `claude` and `codex`. Run [`aireg harnesses`](harnesses.md) to see which ones this machine has.

`--for` also takes the id of a harness you define in a [harness file](harnesses.md#harness-files).

## When aireg asks questions

On a terminal, some commands ask what to install, where to put it and how, then show the plan before changing anything. Every question has an option that answers it, and an option always wins over a question.

aireg never asks a question when any of these is true:

- `--json` or `--yes` (or `--all`) is passed
- input isn't a terminal
- it runs inside a coding agent, such as Claude Code, Codex or Cursor
- `CI` is set, as CI services do

When aireg can't ask, it takes the default answer. If there is no safe default, it stops and tells you which option to pass.

## See also

[CLI reference](index.md)
