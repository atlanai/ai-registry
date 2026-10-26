# aireg targets

List the targets aireg can install into, and which this machine has.

## Synopsis

```text
aireg targets [--all]
aireg targets show <id>
aireg targets check <file>
```

## Description

`aireg targets` lists the coding agents aireg found on this machine, and any a [target file](#target-files) of yours defines. It finds one by its environment variables, its program on your `PATH`, or its folder in the project or your home folder. With `--all`, it lists every target [`--for`](options.md#targets) accepts, found or not.

Each row names a coding agent, the id `--for` takes, and the other names it answers to. Once a [target file](#target-files) of yours defines one, a `from` column says where each target comes from. Below the table, a hint names the ids of the shared `.agents` folder, which has no row.

`targets` doesn't need a project. `aireg harnesses`, its earlier name, still runs it.

## Actions

| Action | Description |
|---|---|
| `show <id>` | Print a target as aireg resolved it. Takes its id or an alias. |
| `check <file>` | Check a target file before you use it. |

## Supported targets

Each path is in a project, then in your user scope. An alias works everywhere an id does; aireg always writes and prints the id.

| Target | `--for` | Aliases | Skills | Agents | Moves the user folder |
|---|---|---|---|---|---|
| Claude Code | `claude-code` | `claude` | `.claude/skills/<name>/`, `~/.claude/skills/<name>/` | `.claude/agents/<name>.md`, `~/.claude/agents/<name>.md` | `CLAUDE_CONFIG_DIR` |
| Codex | `codex` | | `.agents/skills/<name>/`, `~/.agents/skills/<name>/` | `.codex/agents/<name>.toml`, `~/.codex/agents/<name>.toml`, as TOML | `CODEX_HOME` |
| Cursor | `cursor` | | `.agents/skills/<name>/`, `~/.agents/skills/<name>/` | `.cursor/agents/<name>.md`, `~/.cursor/agents/<name>.md` | None |
| GitHub Copilot | `github-copilot` | `copilot` | `.github/skills/<name>/`, `~/.copilot/skills/<name>/` | `.github/agents/<name>.agent.md`, `~/.copilot/agents/<name>.agent.md` | `COPILOT_HOME` |
| Gemini CLI | `gemini-cli` | `gemini` | `.gemini/skills/<name>/`, `~/.gemini/skills/<name>/` | `.gemini/agents/<name>.md`, `~/.gemini/agents/<name>.md`, as a copy | `GEMINI_CLI_HOME` |
| OpenCode | `opencode` | | `.agents/skills/<name>/`, `~/.agents/skills/<name>/` | `.opencode/agents/<name>.md`, `~/.config/opencode/agents/<name>.md`, as a copy | `XDG_CONFIG_HOME` |
| The shared `.agents` folder | `universal` | `agents` | `.agents/skills/<name>/`, `~/.agents/skills/<name>/` | `.agents/agents/<name>.md`, `~/.agents/agents/<name>.md` | None |

The shared `.agents` folder is one several coding agents read, not a coding agent, so aireg never detects it and never installs into it by default.

## Target files

A target file adds a target aireg doesn't ship, or replaces one it does with `"overrides": true`. aireg reads one JSON file per target from `~/.aireg/targets/<id>.json` (`$AIREG_HOME/targets/` when `AIREG_HOME` is set). Only your user scope defines targets: a project can select one by id, in `--for` or its manifest, but never define one.

```json
{
  "id": "tool",
  "aliases": ["tl"],
  "displayName": "Tool",
  "roots": { "project": ".tool", "user": { "default": "~/.tool", "env": "TOOL_HOME" } },
  "detect": { "binary": ["tool"] },
  "reads": { "skill": ["universal"] },
  "kinds": {
    "plugin": { "shape": "contents" },
    "agent": { "shape": "file", "subdir": "agents", "extension": ".md" }
  }
}
```

This target reads skills from the shared `.agents` folder and agents from `.tool/agents/`, takes a plugin as the skills and agents it holds, and answers to `tl` as well as `tool`. [`target.schema.json`](https://github.com/atlanai/ai-registry/blob/main/cli/schema/target.schema.json) describes every key. A file can't set `default`, `importable` or `detect.caller`, which only built-in targets use.

An alias is a lowercase name that isn't another target's id or alias. A file can't take a built-in alias as its id: to replace Claude Code, name the file `claude-code.json`, not `claude.json`, and set `"overrides": true`. A file that replaces a built-in target and sets no `aliases` keeps the built-in's.

`"shared": true` marks a folder several tools read rather than a coding agent, like the shared `.agents` folder. aireg never detects a shared folder and never installs into one by default.

`profiles` finds the profiles of one installation, such as `{ "root": "~/.tool/profiles/{profile}" }`, where `{profile}` in the last segment names each one. Each profile folder found is a target of its own, `<id>:<profile>`, in your user scope only.

A kind placed with `place: "copy"` is written as real files, for a target that edits or refuses links; an edit then shows in `aireg status`. A `codec` rewrites an agent in the target's own format, and refuses to drop or change a key that limits the agent, such as `tools`.

A kind's `keys` say how the target takes a front-matter key it doesn't read as written, such as `disable-model-invocation`: a `.json` or `.yaml` file it reads instead, which aireg writes into a copy of the artifact, or `false`, which leaves out an artifact that sets the key rather than install it without that limit.

aireg skips a file, with a warning, when it isn't valid against the schema, names a codec aireg doesn't have, reaches outside its folders, gives a shell command where a program and its arguments belong, isn't named `<id>.json`, or takes a built-in alias as its id. The built-in targets keep working. Run `aireg targets check <file>` to see what is wrong with one.

### Earlier names

Files written for an earlier aireg keep loading, and a project stays readable by aireg 0.1:

- The lockfile stays version 1. Each row names its target twice: `target:` with the current id, and `harness:` with the id aireg 0.1 reads, such as `claude` for `claude-code`. aireg 0.1 reads `harness:` and ignores `target:`; this version reads `target:`. A lock that needs no change is left byte for byte as it is.
- A manifest moves to `targets:` and today's ids with the next change to its scope: see [`--for`](options.md#targets).

- aireg still reads `~/.aireg/harnesses/`, the folder's earlier name. A target id defined in both folders is refused, naming both files, and neither file is used.
- A file's `kind` is read only as `"kind": "shared"`, which means `"shared": true`; other values are ignored. `aireg targets` and `aireg targets check` warn about a file that sets it.
- `instances` is read as the earlier name of `profiles`, with a warning.

### Trust and reload steps

Some targets load what aireg placed only after you trust it. aireg never takes that step: it prints the command once, and `aireg status --json` lists it under [`needsApproval`](status.md#json-output). It also prints a target's reload step after a change to it.

## Options

| Option | Description |
|---|---|
| `--all` | List every target aireg supports, not only those found. |

## JSON output

```json
{"ok": true, "data": {"targets": [{"name": "claude-code", "aliases": ["claude"], "displayName": "Claude Code", "shared": false, "detected": true, "by": "binary", "origin": "built-in"}], "skipped": []}}
```

The targets are every one `--all` lists, in its order, plus the shared `.agents` folder, which the table leaves out; `shared` is true for it. `name` is the id, and `aliases` the other names it answers to. `by` is `env`, `binary`, `project` or `user`, and is left out when the target wasn't found. `origin` is `built-in` or the path of the file that defines the target. `skipped` lists each target file aireg refused, with its `path` and `problems`.

`show` prints `{"target": {...}}`, the target as aireg resolved it. `check` prints `{"path": "...", "id": "tool", "problems": []}`, with `ok` false when it found a problem.

## Exit status

- `0`: listed, shown, or the file is usable.
- `1`: `check` found a problem with the file.
- `2`: an unknown action, a missing argument, or no target with that id.

## Examples

See which coding agents this machine has:

```bash
aireg targets
```

```text
  target       id           aliases  status  where
  Claude Code  claude-code  claude   found   on your PATH

Found 1 of 6 supported targets on this machine.
hint: Run `aireg targets --all` to see every one.
hint: Use `--for universal`, or `agents`, for the shared .agents folder.
```

See where Codex takes each kind:

```bash
aireg targets show codex
```

Check a target file before you save it in `~/.aireg/targets/`:

```bash
aireg targets check tool.json
```

## See also

[Targets](options.md#targets), [`aireg doctor`](doctor.md), [CLI reference](index.md)
