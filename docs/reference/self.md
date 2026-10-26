# aireg self

Update aireg, or uninstall it.

## Synopsis

```text
aireg self update [--check] [--dry-run] [--force]
aireg self update --rollback [--dry-run]
aireg self uninstall [-y] [--dry-run]
```

## Description

`aireg self` acts on aireg itself, not on what it installs.

## aireg self update

Installs the newest release of aireg. It checks the release's signature and digest before installing it, then restarts the daemon on the new version if it is running. The previous version is kept, so you can go back to it with `--rollback`.

You rarely need to run it: aireg checks for a newer release in the background at most every 15 minutes and installs it, without making commands wait. It does not check when `CI` is set, and `AIREG_DISABLE_UPDATE_CHECK=1` turns the check off.

When a newer release is out but not installed, a command that succeeds ends with a hint naming it. The hint is left out with `--json`, when standard error is not a terminal, and when `CI` or `AIREG_DISABLE_UPDATE_CHECK` is set.

Only an installed aireg updates itself. A build from source doesn't.

| Option | Description |
|---|---|
| `--check` | Say whether a newer release is available, and install nothing. |
| `--dry-run` | Print what would be installed, and install nothing. |
| `--force` | Install the newest release even if it is already installed. |
| `--rollback` | Go back to the version installed before this one. |

## aireg self uninstall

Stops the daemon and turns autostart off, removes what your user scope installed in target folders, deletes the line the installer added to your shell startup files, and deletes `~/.aireg` and `~/.registry`, or `AIREG_HOME` and `AIREG_USER_SCOPE` if you set them. Files aireg didn't install are left alone.

Projects keep their `.registry/` folder. To take aireg out of a project too, run `aireg remove --all` there first.

On a terminal, `uninstall` lists what it will remove and asks first. Without a terminal, pass `-y`.

| Option | Description |
|---|---|
| `-y`, `--yes` | Don't ask before removing. |
| `--dry-run` | Print what would be removed, and remove nothing. |

## JSON output

`update` prints:

```json
{"ok": true, "data": {"current": "X.Y.Z", "latest": "X.Y.Z", "action": "updated", "bin": "/home/me/.aireg/bin/aireg", "dryRun": false}}
```

After an update, `current` is the version now installed, the same as `latest`. `action` is one of:

| Action | Meaning |
|---|---|
| `already-latest` | The newest release is installed. |
| `update-available` | With `--check`, a newer release is available. |
| `would-update` | With `--dry-run`, this release would be installed. |
| `updated` | The newest release was installed. |
| `would-rollback` | With `--rollback --dry-run`, this version would be restored. |
| `rolled-back` | The previous version was restored. |

`uninstall` prints:

```json
{"ok": true, "data": {"action": "uninstalled", "dryRun": false, "daemon": true, "autostart": false, "links": ["/home/me/.claude/skills/engineering"], "startupFiles": ["/home/me/.profile", "/home/me/.zshenv"], "folders": ["/home/me/.registry", "/home/me/.aireg"], "kept": []}}
```

With `--dry-run`, `action` is `would-uninstall` and `dryRun` is `true`. `kept` lists what was left in place, such as a CLI the installer didn't put there.

## Exit status

- `0`: updated, already current, rolled back, uninstalled, or canceled at the question.
- `1`: the release couldn't be downloaded or verified, there is no previous version to roll back to, this build doesn't update itself, or something couldn't be removed.
- `2`: the action is unknown, an argument or an unknown option was given, or `uninstall` can't ask and `-y` wasn't passed.

## Examples

Update aireg:

```bash
aireg self update
```

Check for a newer release without installing it:

```bash
aireg self update --check
```

See what uninstalling would remove:

```bash
aireg self uninstall --dry-run
```

## See also

[`aireg doctor`](doctor.md), [`aireg remove`](remove.md), [CLI reference](index.md)
