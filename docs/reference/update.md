# aireg update

Take the newest version each registry offers.

## Synopsis

```text
aireg update [<name> | <registry>]... [-g] [--for <harness>,...] [--frozen] [--copy] [--dry-run] [-y]
```

`aireg upgrade` is the same command.

## Description

`aireg update` reads each registry again and installs the newest version of every artifact the scope takes from it. Name installed artifacts, as [`aireg list`](list.md) shows them, or registries, to update only those.

An artifact pinned to a version, such as `acme/engineering/pr-review@1.2.0`, stays at that version, with a warning. Move the pin with `aireg add acme/engineering/pr-review@<version>`, or remove it with `aireg add acme/engineering/pr-review`. A dependency stays at the version the artifacts that need it name, and moves when they do.

When the manifest takes a whole namespace, `update` also installs the artifacts the namespace has published since.

An installed artifact that its registry no longer lists stays installed: `update` takes everything else, then fails, naming it and the `aireg remove <name>` that takes it out.

`update` doesn't overwrite your edits. To take the registry's copy over your edit, run [`aireg sync resolve <name> --theirs`](sync.md#aireg-sync-resolve). To discard edits made here, run [`aireg install --force`](install.md).

## Options

| Option | Description |
|---|---|
| `--frozen` | Fail with exit status 3 instead of changing the lockfile or the manifest. |
| `--for <harness>[,<harness>...]` | Install into these harnesses for this run, instead of the manifest's. |
| `--copy` | Copy into each harness folder instead of linking, for this run. To keep an artifact copied, add it with `aireg add --copy`. |
| `--dry-run` | Print the plan, and change nothing. |
| `-y`, `--yes` | Don't ask before removing anything. |

`update` also takes `-g`. See [Command options](options.md#command-options).

## JSON output

```json
{"ok": true, "data": {"dryRun": false, "changed": 1, "installed": ["engineering/pr-review"], "kept": []}}
```

The fields are those of [`aireg add`](add.md#json-output).

## Exit status

- `0`: updated, or already up to date.
- `1`: a name isn't installed, a registry can't be read, a registry no longer lists an installed artifact, or a file doesn't match what its version describes.
- `2`: `--force` was passed, run outside a project without `-g`, or an artifact's name is taken and `defaults.name-collision` is `fail`.
- `3`: `--frozen` was passed and the update would change the lockfile or the manifest, or an artifact wasn't installed because its name is taken and `defaults.name-collision` is `report`.

## Examples

See what has a newer version, then take it. `outdated` exits 3 when something has, so run the two separately rather than with `&&`:

```bash
aireg outdated
aireg update
```

Update only what came from one registry:

```bash
aireg update acme
```

## See also

[`aireg install`](install.md), [`aireg add`](add.md), [`aireg outdated`](outdated.md), [CLI reference](index.md)
