# aireg install

Make this project match its manifest.

## Synopsis

```text
aireg install [-g] [--for <harness>[,<harness>...]] [--frozen] [--force] [--copy] [--dry-run] [-y]
```

`aireg i` is the same command.

## Description

`aireg install` installs everything the scope's manifest names, at the versions the lockfile records: it fetches from the registry only what the scope doesn't hold yet, stores it in the scope, links it into each harness folder and writes the lockfile. A reference the lockfile doesn't resolve yet, such as one just added to the manifest, is installed at its newest version. [`aireg update`](update.md) moves what the lockfile records, and adds what a namespace has published since. Run it after cloning a project, or after pulling a change to `.registry/manifest.yml`. Run twice in a row, the second run changes nothing.

`install` never writes through a symlinked folder on the way to a harness folder, such as a committed `.claude/skills` that points outside the project: it leaves that link out and says why. A folder of yours already where a link would go is left alone too, and [`aireg status`](status.md) reports the link as missing until you move it. A file or folder of yours that replaced a link aireg made is different: `install` moves it to `.registry/backups/`, says where, and restores the link.

A version's status in its registry decides whether it installs, as [Version status](kinds.md#version-status) describes: a `blocked` version never does, and a `deprecated` one installs with a warning.

An installed artifact that its registry no longer lists stays installed, with a warning and the `aireg remove <name>` that takes it out: a listing cut short or emptied never removes anything.

An installed copy that was edited after it was installed is kept, with a warning. Pass `--force` to restore the copy the lockfile records instead, or run [`aireg sync`](sync.md) to see how your edit compares with the registry.

Pass `--frozen` to install exactly what the lockfile records: `install` then fails with exit status 3 if the lockfile or the manifest would change.

`install` asks before changing anything only when the plan would remove something.

## Options

| Option | Description |
|---|---|
| `--frozen` | Fail with exit status 3 instead of changing the lockfile or the manifest. |
| `--force` | Restore installed copies that were edited after they were installed. |
| `--for <harness>[,<harness>...]` | Install into these harnesses for this run, instead of the manifest's. |
| `--copy` | Copy into each harness folder instead of linking, for this run. To keep an artifact copied, add it with `aireg add --copy`. |
| `--dry-run` | Print the plan, and change nothing. |
| `-y`, `--yes` | Don't ask before removing anything. |

`install` also takes `-g`, to install your user scope from `~/.registry/manifest.yml`. See [Command options](options.md#command-options).

## JSON output

```json
{"ok": true, "data": {"dryRun": false, "changed": 2, "installed": ["engineering/pr-review"], "kept": [], "unchanged": []}}
```

The fields are those of [`aireg add`](add.md#json-output).

## Exit status

- `0`: installed, or already up to date.
- `1`: a registry or the lockfile can't be read, a registry serves other content for a version the lockfile records, a file doesn't match what its version describes, the manifest names an unknown harness, a harness folder can't be written, or the project needs a newer aireg.
- `2`: run outside a project without `-g`, `--for` names an unknown harness, an argument was given, or an artifact's name is taken and `defaults.name-collision` is `fail`.
- `3`: `--frozen` was passed and the install would change the lockfile or the manifest, or an artifact wasn't installed because its name is taken and `defaults.name-collision` is `report`.

## Examples

Install what a project's manifest names, after cloning it:

```bash
aireg install
```

In CI, install what the lockfile records, and fail if it is out of date or an installed copy was edited:

```bash
aireg install --frozen && aireg status
```

## See also

[`aireg add`](add.md), [`aireg update`](update.md), [`aireg status`](status.md), [CLI reference](index.md)
