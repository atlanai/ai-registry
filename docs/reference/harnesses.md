# aireg harnesses

List the harnesses aireg can install into, and which this machine has.

## Synopsis

```text
aireg harnesses [--all]
aireg harnesses show <id>
aireg harnesses check <file>
```

## Description

`aireg harnesses` lists the coding agents aireg found on this machine, and any a [harness file](#harness-files) of yours defines. It finds one by its environment variables, its program on your `PATH`, or its folder in the project or your home folder. With `--all`, it lists every harness name [`--for`](options.md#harnesses) accepts, found or not.

Each row names a coding agent and the id `--for` takes. Once a [harness file](#harness-files) of yours defines one, a `from` column says where each harness comes from.

`harnesses` doesn't need a project.

## Actions

| Action | Description |
|---|---|
| `show <id>` | Print a harness as aireg resolved it. |
| `check <file>` | Check a harness file before you use it. |

## Harness files

A harness file adds a harness aireg doesn't ship, or replaces one it does with `"overrides": true`. aireg reads one JSON file per harness from `~/.aireg/harnesses/<id>.json` (`$AIREG_HOME/harnesses/` when `AIREG_HOME` is set). Only your user scope defines harnesses: a project can select one by id, in `--for` or its manifest, but never define one.

```json
{
  "id": "tool",
  "displayName": "Tool",
  "roots": { "project": ".tool", "user": { "default": "~/.tool", "env": "TOOL_HOME" } },
  "detect": { "binary": ["tool"] },
  "reads": { "skill": ["agents"] },
  "kinds": {
    "plugin": { "shape": "contents" },
    "agent": { "shape": "file", "subdir": "agents", "extension": ".md" }
  }
}
```

This harness reads skills from the shared `.agents` folder and agents from `.tool/agents/`, and takes a plugin as the skills and agents it holds. [`harness.schema.json`](https://github.com/atlanai/ai-registry/blob/main/cli/schema/harness.schema.json) describes every key. A file can't set `default`, `importable` or `detect.caller`, which only built-in harnesses use.

A kind placed with `place: "copy"` is written as real files, for a harness that edits or refuses links; an edit then shows in `aireg status`. A `codec` rewrites an agent in the harness's own format, and refuses to drop or change a key that limits the agent, such as `tools`.

A kind's `keys` say how the harness takes a front-matter key it doesn't read as written, such as `disable-model-invocation`: a `.json` or `.yaml` file it reads instead, which aireg writes into a copy of the artifact, or `false`, which leaves out an artifact that sets the key rather than install it without that limit.

aireg skips a file, with a warning, when it isn't valid against the schema, names a codec aireg doesn't have, reaches outside its folders, gives a shell command where a program and its arguments belong, or isn't named `<id>.json`. The built-in harnesses keep working. Run `aireg harnesses check <file>` to see what is wrong with one.

### Trust and reload steps

Some harnesses load what aireg placed only after you trust it. aireg never takes that step: it prints the command once, and `aireg status --json` lists it under [`needsApproval`](status.md#json-output). It also prints a harness's reload step after a change to it.

## Options

| Option | Description |
|---|---|
| `--all` | List every harness aireg supports, not only those found. |

## JSON output

```json
{"ok": true, "data": {"harnesses": [{"name": "claude", "displayName": "Claude Code", "kind": "coding", "shared": false, "detected": true, "by": "binary", "origin": "built-in"}], "skipped": []}}
```

The harnesses are every one `--all` lists, in its order, plus the shared `.agents` folder, which the table leaves out; `shared` is true for it. `by` is `env`, `binary`, `project` or `user`, and is left out when the harness wasn't found. `origin` is `built-in` or the path of the file that defines the harness. `skipped` lists each harness file aireg refused, with its `path` and `problems`.

`show` prints `{"harness": {...}}`, the harness as aireg resolved it. `check` prints `{"path": "...", "id": "tool", "problems": []}`, with `ok` false when it found a problem.

## Exit status

- `0`: listed, shown, or the file is usable.
- `1`: `check` found a problem with the file.
- `2`: an unknown action, a missing argument, or no harness with that id.

## Examples

See which coding agents this machine has:

```bash
aireg harnesses
```

```text
  harness      id      status  where
  Claude Code  claude  found   on your PATH

Found 1 of 3 supported harnesses on this machine.
hint: Run `aireg harnesses --all` to see every one.
```

See where Codex takes each kind:

```bash
aireg harnesses show codex
```

Check a harness file before you save it in `~/.aireg/harnesses/`:

```bash
aireg harnesses check tool.json
```

## See also

[Harnesses](options.md#harnesses), [`aireg doctor`](doctor.md), [CLI reference](index.md)
