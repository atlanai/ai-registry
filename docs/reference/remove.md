# aireg remove

Uninstall artifacts.

## Synopsis

```text
aireg remove <name>... [options]
aireg remove --all [options]
aireg remove
```

`aireg rm` is the same command.

## Description

`aireg remove` uninstalls artifacts from the current project, or with `-g` from your user scope. It removes each artifact's links from the harness folders and its stored copy, and updates the manifest and lockfile, then removes the dependencies nothing else needs any more. Files aireg didn't install are left alone: a folder or file of yours that replaced one of its links is moved to `.registry/backups/`, and `remove` names where it went.

An artifact another installed artifact still needs is kept, and `remove` says which one needs it. So is one a job publishes from a folder of yours, since the job goes on reading that folder: `remove` names it, and [`aireg watch remove <folder>`](watch.md#aireg-watch-remove) stops publishing that folder.

A name can be an installed artifact's name, as [`aireg list`](list.md) shows it, a longer form of it such as `engineering/pr-review`, or the full name [`aireg add`](add.md) takes. So `aireg remove acme/engineering/pr-review` undoes `aireg add acme/engineering/pr-review`.

When the artifact came in with a whole namespace or registry, the manifest keeps that entry and records the artifact as excluded, so the rest of the namespace still arrives, and what it publishes later arrives with [`aireg update`](update.md). That holds for its last installed artifact too. `remove` itself never installs anything new. To drop the namespace itself, remove it by its full name, such as `aireg remove acme/frontend`.

An artifact edited since it was installed, including the copy in a harness folder of a `--copy` install, is not removed: `remove` stops and names it. Run [`aireg sync`](sync.md) to see how the edit compares with its registry, or pass `--force` to delete it.

`remove` doesn't remove the registry's declaration. Do that with [`aireg registry remove`](registry.md#aireg-registry-remove).

On a terminal, `remove` shows the plan and asks before changing anything. With no names, it asks which artifacts to remove.

## Options

| Option | Description |
|---|---|
| `-s`, `--select <name>` | An artifact to remove. The same as naming it. |
| `--all` | Remove every installed artifact in the scope, without asking. |
| `-y`, `--yes` | Don't ask before removing. |
| `--force` | Remove artifacts even if they were edited after they were installed. |
| `--dry-run` | Print what would be removed, and change nothing. |

`remove` also takes `-g` and `--frozen`. See [Command options](options.md#command-options).

## JSON output

```json
{"ok": true, "data": {"dryRun": false, "removed": ["engineering/pr-review"], "pruned": [], "watched": []}}
```

`pruned` holds the dependencies removed with them. An artifact another one still needs stays installed, and isn't in `removed`. `watched` holds the ones kept because a job publishes them from your folders.

## Exit status

- `0`: removed, or canceled at a question.
- `1`: nothing is installed, or a name isn't installed.
- `2`: run outside a project without `-g`, a name matches more than one artifact, or nothing was named and aireg can't ask.
- `3`: an artifact has local edits and `--force` wasn't passed, `--frozen` was passed, or an artifact wasn't installed because its name is taken and `defaults.name-collision` is `report`. A removal always changes the lockfile or the manifest, so it always fails that check, even for an artifact that stays installed because another one needs it.

## Examples

Remove one artifact:

```bash
aireg remove pr-review
```

Remove everything installed in your user scope:

```bash
aireg remove -g --all
```

## See also

[`aireg add`](add.md), [`aireg list`](list.md), [CLI reference](index.md)
