# aireg harnesses

List the harnesses aireg can install into, and which this machine has.

## Synopsis

```text
aireg harnesses
aireg harnesses show <id>
aireg harnesses check <file>
```

## Description

`aireg harnesses` lists every harness name [`--for`](options.md#harnesses) accepts, and whether aireg found that coding agent on this machine. It finds one by its environment variables, its program on your `PATH`, or its folder in the project or your home folder.

Each row names a coding agent and the id `--for` takes. A line under the table names the agents that read the shared `.agents` folder. Once a [harness file](#harness-files) of yours defines a harness, a `from` column says which file each one comes from, and a file aireg can't use is named in a warning, with what is wrong with it.

`harnesses` doesn't need a project.

## Actions

| Action | Description |
|---|---|
| `show <id>` | Print a harness as aireg resolved it: its folders, how it is detected, where each kind lands, and any trust or reload step. |
| `check <file>` | Check a harness file before you use it, wherever it is. |

## Harness files

A harness file defines a harness aireg doesn't ship, or replaces one it does, without waiting for a release. aireg reads one JSON file per harness from `~/.aireg/harnesses/<id>.json` (`$AIREG_HOME/harnesses/` when `AIREG_HOME` is set), and the file's name is its id. [Add a harness](add-a-harness.md) walks through writing one.

Only your user scope defines a harness. A project may select one by id, in `--for` or its manifest's `harnesses:` list, but never define one, so a repository you clone can't point aireg at folders of its choosing.

A file holds the same keys a built-in harness has, as [`harness.schema.json`](https://github.com/atlanai/ai-registry/blob/main/cli/schema/harness.schema.json) describes:

| Key | What it says |
|---|---|
| `id`, `displayName` | The name `--for` takes, and the name aireg prints. |
| `overrides` | `true` to replace the built-in harness with this id. |
| `kind` | `coding` (the default), `personal`, or `shared` for a folder several tools read. |
| `roots` | `project`, the folder in a project, and `user.default`, the folder under `~/`. `user.env` names the variable the harness itself reads to move it, and `user.within` the root's path inside the folder that variable names, for a variable that names the folder holding the root. |
| `detect` | Lists of variables (`env`), programs (`binary`) and folders (`paths`) whose presence means the harness is installed, or `never`. |
| `reads` | The harnesses whose folders it also reads, per kind, most preferred first. |
| `kinds` | Where each of `skill`, `agent` and `plugin` lands; see below. |
| `verified` | `command`, the program and arguments that print its version, and `range`, the versions this was checked against. |
| `trust` | Per kind, a command a person runs before the harness loads what aireg placed, and the `scope` it applies to. |
| `instances` | `root`, a folder under `~/` with `{profile}` in its last segment: each profile folder found there is a harness of its own, `<id>:<profile>`. |
| `reload` | What to do for the harness to see a change. |

Each entry under `kinds` has a `shape`:

- `contents` places nothing of its own: a plugin lands as the skills and agents it holds, where those kinds go.
- `directory` places a folder per artifact under `subdir`. `place` is `link` (the default), `fan`, a real folder of links, or `copy`, real files, for a harness that rewrites or refuses links. For an agent, `entry` names the file it lands as inside its own folder, such as `AGENT.md`. A plugin's `manifest` lists the manifests aireg writes into it.
- `file` places one file per artifact, `<subdir>/<name><extension>`, linked or, with `place: "copy"`, copied.

`scope: "user"` keeps a kind out of projects. `register` lists edits to the harness's own TOML, JSON or YAML config that make it load what was placed; aireg makes each edit while a placement needs it, keeps the comments and key order a person wrote in a YAML file, and takes the edit back with the last placement. An `append` entry adds one item to a YAML list, with an `# aireg` comment beside it; aireg takes out only an item it marked, so one you listed yourself stays. `codec` rewrites the file a harness reads in its own format, with one of the codecs aireg builds in:

| Codec | What it writes |
|---|---|
| `frontmatter-toml` | The front-matter `fields` and the body under `body`, as TOML. |
| `frontmatter-strict` | Only the front-matter keys in `keep`. |
| `frontmatter-set` | The front matter with the keys in `set` added or changed. |

A codec that would drop or change a key that limits what an agent may use writes nothing and says why, rather than let the agent do more than its author allowed. Those keys are `tools`, `allowed-tools`, `disallowedTools`, `permissionMode` and `permission`, and any the codec's `restrictions` add. A file names a codec; it never carries code.

### What aireg refuses

`check`, and every command that reads your harnesses, refuses a file that:

- isn't valid JSON, or has a key the schema doesn't know;
- names a codec aireg doesn't build in;
- puts a root outside your home folder or the project, or a config file or manifest outside its harness's folder, including through `..`;
- gives `detect` or `verified` a shell command instead of a program and a list of arguments;
- uses an id another harness has, without `"overrides": true` for a built-in one;
- is named other than `<id>.json`, or links to a file outside `~/.aireg/harnesses/`.

A file aireg refuses is skipped with a warning, and the built-in harnesses keep working.

### Trust and reload steps

aireg never takes a trust step for you. After it places a kind whose harness names a `trust` command for that scope, it prints the command once. For a harness named Tool whose file sets `"trust": {"skill": {"run": "tool trust"}}`:

```text
hint: Tool loads skills here only after you run `tool trust`.
```

[`aireg status --json`](status.md#json-output) lists the same commands under each artifact's `needsApproval`. A harness's `reload` is printed after any change to it.

## Options

`harnesses` has no options of its own.

## JSON output

```json
{"ok": true, "data": {"harnesses": [{"name": "claude", "displayName": "Claude Code", "kind": "coding", "shared": false, "detected": true, "by": "binary", "origin": "built-in"}], "skipped": []}}
```

The harnesses are in the order the text lists them, plus the shared `.agents` folder, which the table leaves out; `shared` is true for it. `by` is `env`, `binary`, `project` or `user`, and is left out when the harness wasn't found. `origin` is `built-in` or the path of the file that defines the harness. `skipped` lists each harness file aireg refused, with its `path` and `problems`.

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
  harness      id      status     where
  Claude Code  claude  found      on your PATH
  Codex        codex   not found
  Cursor       cursor  not found

Codex and Cursor read skills from the shared .agents folder.
Found 1 of 3 supported harnesses on this machine.
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

[Add a harness](add-a-harness.md), [Harnesses](options.md#harnesses), [`aireg doctor`](doctor.md), [CLI reference](index.md)
