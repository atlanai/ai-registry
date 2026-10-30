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

Pass the id to `--for`. The earlier ids `claude`, `copilot`, `gemini` and `agents` still work everywhere an id does.

### Skills

| Target | `--for` | Project | User |
|---|---|---|---|
| Claude Code | `claude-code` | `.claude/skills/` | `~/.claude/skills/` |
| Codex | `codex` | `.agents/skills/` | `~/.agents/skills/` |
| Cursor | `cursor` | `.agents/skills/` | `~/.agents/skills/` |
| GitHub Copilot | `github-copilot` | `.github/skills/` | `~/.copilot/skills/` |
| Gemini CLI | `gemini-cli` | `.gemini/skills/` | `~/.gemini/skills/` |
| OpenCode | `opencode` | `.agents/skills/` | `~/.agents/skills/` |
| Grok Build | `grok` | `.grok/skills/` | `~/.grok/skills/` |
| Pi | `pi` | `.agents/skills/` | `~/.agents/skills/` |
| Shared `.agents` folder | `universal` | `.agents/skills/` | `~/.agents/skills/` |

### Agents

| Target | `--for` | Project | User |
|---|---|---|---|
| Claude Code | `claude-code` | `.claude/agents/` | `~/.claude/agents/` |
| Codex | `codex` | `.codex/agents/` | `~/.codex/agents/` |
| Cursor | `cursor` | `.cursor/agents/` | `~/.cursor/agents/` |
| GitHub Copilot | `github-copilot` | `.github/agents/` | `~/.copilot/agents/` |
| Gemini CLI | `gemini-cli` | `.gemini/agents/` | `~/.gemini/agents/` |
| OpenCode | `opencode` | `.opencode/agents/` | `~/.config/opencode/agents/` |
| Grok Build | `grok` | `.grok/agents/` | `~/.grok/agents/` |
| Shared `.agents` folder | `universal` | `.agents/agents/` | `~/.agents/agents/` |

Pi has no agents, so aireg installs none for it.

A user folder moves with its target's own variable: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `GEMINI_CLI_HOME`, `GROK_HOME`, `PI_CODING_AGENT_DIR`, or `XDG_CONFIG_HOME` for OpenCode.

With `GEMINI_CLI_HOME` set, Gemini CLI reads `.agents/skills` inside that folder, not the shared `~/.agents/skills`. aireg places Gemini CLI's own skills under the variable, but a skill you install for Gemini CLI together with a target that reads `~/.agents`, such as Codex, lands only in that shared folder, where Gemini CLI does not look. While the variable is set, install for Gemini CLI on its own: `aireg add -g <source> --for gemini-cli`.

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

`category` groups targets: `coding-agent`, the default, `personal-agent`, or `shared-folder` for a folder several tools read, like the shared `.agents` folder. aireg never detects a shared folder and never installs into one by default.

`profiles` finds the profiles of one installation, such as `{ "root": "~/.tool/profiles/{profile}" }`, where `{profile}` in the last segment names each one. Each profile folder found is a target of its own, `<id>:<profile>`, in your user scope only.

A kind placed with `place: "copy"` is written as real files, for a target that edits or refuses links; an edit then shows in `aireg status`. A `codec` rewrites an agent in the target's own format, and refuses to drop or change a key that limits the agent, such as `tools`.

A kind's `keys` say how the target takes a front-matter key it doesn't read as written, such as `disable-model-invocation`: a `.json` or `.yaml` file it reads instead, which aireg writes into a copy of the artifact, or `false`, which leaves out an artifact that sets the key rather than install it without that limit.

aireg skips a file, with a warning, when it isn't valid against the schema, names a codec aireg doesn't have, reaches outside its folders, gives a shell command where a program and its arguments belong, isn't named `<id>.json`, or takes a built-in alias as its id. The built-in targets keep working. Run `aireg targets check <file>` to see what is wrong with one.

### Earlier names

Files written for an earlier aireg keep loading, and a project stays readable by aireg 0.1:

- The lockfile stays version 1. Each row names its target twice: `target:` with the current id, and `harness:` with the id aireg 0.1 reads, such as `claude` for `claude-code`. aireg 0.1 reads `harness:` and ignores `target:`; this version reads `target:`. A lock that needs no change is left byte for byte as it is.
- aireg reads a manifest's target list as `targets:` or `harnesses:`, and writes it as `harnesses:` with the ids aireg 0.1 knows unless the manifest says `targets:`: see [`--for`](options.md#targets).
- aireg still reads `~/.aireg/harnesses/`, the folder's earlier name, with a warning. A file there named for a built-in's earlier id, such as `claude.json` with `"overrides": true`, replaces that built-in, as it did in aireg 0.1, and aireg warns you to rename it `claude-code.json` with that id. A target id defined in both folders is refused, naming both files, and neither file is used.
- Where a file of yours gives a built-in other `aliases`, so the id aireg 0.1 knew no longer names it, aireg writes today's id in the manifest, the lockfile and its output instead.
- A file's `kind` is read as the earlier name of `category`: `coding`, `personal` and `shared` mean `coding-agent`, `personal-agent` and `shared-folder`, and other values are ignored. A file that sets both is refused. `aireg targets` and `aireg targets check` warn about a file that sets `kind`.
- `instances` is read as the earlier name of `profiles`, with a warning.

### Trust and reload steps

Some targets load what aireg placed only after you trust it. aireg never takes that step: it prints the command once, and `aireg status --json` lists it under [`needsApproval`](status.md#json-output). It also prints a target's reload step after a change to it.

## Options

| Option | Description |
|---|---|
| `--all` | List every target aireg supports, not only those found. |

## JSON output

```json
{"ok": true, "data": {"targets": [{"name": "claude-code", "aliases": ["claude"], "displayName": "Claude Code", "shared": false, "detected": true, "by": "binary", "origin": "built-in"}], "harnesses": [{"name": "claude", "displayName": "Claude Code", "kind": "coding", "shared": false, "detected": true, "by": "binary", "origin": "built-in"}], "skipped": [], "warnings": []}}
```

The targets are every one `--all` lists, in its order, plus the shared `.agents` folder, which the table leaves out; `shared` is true for it. `name` is the id, and `aliases` the other names it answers to. `by` is `env`, `binary`, `project` or `user`, and is left out when the target wasn't found. `origin` is `built-in` or the path of the file that defines the target. `skipped` lists each target file aireg refused, with its `path` and `problems`. `warnings` lists each file aireg uses but would have you change, such as one in the folder's earlier name, with its `path` and `warnings`. `harnesses` is the same list as `aireg harnesses --json` printed it in aireg 0.1, named by the ids that version knows and with `kind`, kept for compatibility.

`show` prints `{"target": {...}, "harness": {...}}`: the target as aireg resolved it, and again as aireg 0.1 printed it. `check` prints `{"path": "...", "id": "tool", "problems": [], "warnings": []}`, with `ok` false when it found a problem.

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
