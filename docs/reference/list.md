# aireg list

List what is installed.

## Synopsis

```text
aireg list [-g]
aireg list <name> [-g]
```

`aireg ls` is the same command.

## Description

`aireg list` lists the artifacts installed in the current project, or with `-g` or outside a project in your user scope, from the lockfile. It doesn't contact any registry. The table shows each artifact's kind, version and registry, and the targets that load it. A version marked `pinned` is held by the manifest. An artifact installed only because others depend on it names them under `needed by`. A skill or agent from a watched folder shows the target that reads it, such as `Cursor (watched)`.

The table names each artifact by the shortest name no other installed artifact shares, such as `pr-review`. Wherever aireg asks for an installed artifact's name, a longer form works too, such as `engineering/pr-review` or `acme/engineering/skill/pr-review`.

With a name, `list` shows where one installed artifact came from: its registry, the registry snapshot, its version and content digest, the stored copy you edit, and its link in each target folder.

## Options

`list` takes `-g`, to list your user scope. See [Command options](options.md#command-options).

## JSON output

```json
{"ok": true, "data": {"scope": "project", "artifacts": [{"name": "engineering/pr-review", "shown": "pr-review", "kind": "skill", "registry": "acme", "address": "github.com/acme/ai-registry", "ref": "0.1.0", "pinned": false, "targets": ["agents", "claude"]}]}}
```

`name` is the artifact's name in the lockfile, and `shown` the name the table prints. `address` is where its registry lives. `targets` are the targets it is linked into, by the ids aireg 0.1 used, such as `claude` for Claude Code and `agents` for the shared `.agents` folder, so readers of that version keep working. `ref` is the version; an artifact with no version has its registry's short commit instead, or nothing when it comes from a watched folder. `watched` names the `target` and `path` of an artifact from a watched folder, and its `harness`, the target by the id aireg 0.1 used, kept for compatibility, and `neededBy` the artifacts that need one installed only for them.

With a name, `data` is that one artifact instead: where it came from, its `version` and `content` digest, the stored `copy` you edit, and its `links` into each target folder.

```json
{"ok": true, "data": {"name": "pr-review", "kind": "skill", "registry": "acme", "address": "github.com/acme/ai-registry", "adapter": "git", "registryKey": "sha256:...", "config": {}, "revision": "4e1d2c9...", "id": "artifacts/engineering/skill/pr-review/0.1.0", "upstreamName": "pr-review", "content": "sha256:...", "version": "0.1.0", "path": ".registry/artifacts/acme/engineering/skills/pr-review", "copy": ".registry/artifacts/acme/engineering/skills/pr-review", "links": [{"target": "claude-code", "harness": "claude", "path": ".claude/skills/pr-review", "mode": "symlink"}]}}
```

Each link also names its target as `harness`, by the id aireg 0.1 used, for scripts written against it.

## Exit status

- `0`: listed.
- `1`: the named artifact isn't installed.

## Examples

List what this project installs:

```bash
aireg list
```

```text
1 installed in this project
  artifact   kind   version  from  targets
  pr-review  skill  0.1.0    acme  Claude Code, Codex
```

See where an installed skill came from:

```bash
aireg list pr-review
```

## See also

[`aireg status`](status.md), [`aireg outdated`](outdated.md), [CLI reference](index.md)
