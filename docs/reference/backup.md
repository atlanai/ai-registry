# aireg backup

See or restore files of yours that aireg moved aside.

## Synopsis

```text
aireg backup list [-g]
aireg backup restore [<stamp>] [-g]
```

`aireg backup` on its own runs `aireg backup list`.

## Description

aireg never deletes a file or folder of yours that stands where it works. When a command has to clear one out of a target folder, such as a skill folder that replaced a link [`aireg install`](install.md) made, it renames it into the scope's `.registry/backups/`, in one run per command named by its time: `20261009T062247Z/claude-code/skills/lint` holds what sat in Claude Code's `skills` folder as `lint`. See [Environment and files](environment.md#project-files).

`aireg backup` reads those runs for the current project, or with `-g` for your user scope. Outside a project it acts on your user scope.

## aireg backup list

Lists the runs newest first. For each it prints the stamp, when it ran and how many items it holds per target, then each item, the target it came from and the path it goes back to. aireg reads that path back from the run's filing and the targets on this machine; an item it cannot place, such as one from a target no longer defined, shows `unknown`. `ls` is the same command.

## aireg backup restore

Puts what one run moved aside back where it was. Name the run by its stamp; on a terminal without one, aireg offers the runs to choose from.

For each item:

- When its path is free, the item is renamed back.
- When something else stands there now, aireg asks whether to keep the current one, leaving the item in backups, or to replace it. A replaced file or folder is not deleted: it moves to a new run, which `aireg backup list` shows.
- When aireg itself installed an artifact there, the item stays in backups. Remove that artifact with [`aireg remove`](remove.md) first.
- When the path is one aireg may not write to, such as a folder reached through a symlink, or aireg cannot tell where the item came from, it stays in backups.

Before anything moves, aireg shows the plan and asks to go ahead. With `-y`, or without a terminal, it asks nothing, restores each item whose path is free and leaves the rest in backups, naming each. Restoring never changes the manifest or the lockfile: what comes back is yours, not something aireg installed.

| Option | Description |
|---|---|
| `-g` | Restore a run from your user scope. |

## JSON output

| Action | `data` |
|---|---|
| `list` | `{"scope": "user", "root": "/home/me/.registry/backups", "runs": [{"stamp": "20261009T062247Z", "at": "2026-10-09T06:22:47.000Z", "counts": {"claude-code": 1}, "items": [{"name": "lint", "target": "claude-code", "dir": "skills", "path": "/home/me/.registry/backups/20261009T062247Z/claude-code/skills/lint", "origin": "/home/me/.claude/skills/lint"}]}]}`: `origin` is absent when aireg cannot tell where an item came from |
| `restore` | `{"scope": "user", "stamp": "20261009T062247Z", "restored": [{"name": "lint", "target": "claude-code", "path": "/home/me/.claude/skills/lint"}], "skipped": [{"name": "review", "target": "claude-code", "path": "/home/me/.claude/skills/review", "reason": "taken"}]}`: a restored item that replaced something has `replaced`, the new backup holding it; `reason` is `kept`, `taken`, `installed`, `refused` or `unknown` |

## Exit status

- `0`: the runs were listed, or the run was restored, including any items left in backups.
- `1`: no run has that stamp, or the scope has no backups to restore.
- `2`: the action is unknown, or `restore` named no run and could not offer a list.

## Examples

See what aireg moved out of your tools' folders:

```bash
aireg backup list -g
```

Choose a run and put what it moved back:

```bash
aireg backup restore -g
```

Restore one run without being asked, leaving anything whose place is taken in backups:

```bash
aireg backup restore -g 20261009T062247Z -y
```

## See also

[`aireg install`](install.md), [`aireg remove`](remove.md), [`aireg status`](status.md), [CLI reference](index.md)
