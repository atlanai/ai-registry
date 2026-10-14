# aireg outdated

Check each registry for newer versions of what is installed.

## Synopsis

```text
aireg outdated [-g]
```

## Description

`aireg outdated` asks each registry the scope installs from what it publishes now, and compares that with the lockfile. It changes nothing. Outside a project it checks your user scope.

The table lists each artifact with a newer version: its registry, the version installed and the newest one. An artifact pinned in the manifest is marked `pinned`. When the manifest takes a whole namespace, artifacts the namespace has published since are listed as `new`, except ones you removed from it with [`aireg remove`](remove.md). An artifact a watched folder publishes is marked `watched`. A registry's latest version that is older than the one installed, as after the installed one is yanked, isn't newer, so it isn't listed.

`outdated` warns about each artifact it couldn't check, for example because its registry couldn't be read or no longer publishes it. It ends with `aireg update` when something unpinned can move.

## Options

`outdated` takes `-g`, to check your user scope. See [Command options](options.md#command-options).

## JSON output

```json
{"ok": true, "data": {"scope": "project", "artifacts": [{"name": "engineering/pr-review", "registry": "acme", "current": "1.2.0", "latest": "1.3.0", "moved": true}]}}
```

A pinned artifact also has `pinned`, the version the manifest pins, such as `"1.2.0"`. One that couldn't be checked has `unchecked`, with the reason. One published since the last install, under a namespace or registry the manifest takes whole, has `"added": true` and an empty `current`.

## Exit status

- `0`: everything is current, only pinned artifacts are behind, or the rest isn't published yet.
- `2`: an argument was given.
- `3`: something unpinned has a newer version, or something couldn't be checked.

## Examples

See what has a newer version, then take it. `outdated` exits 3 when something has, so run the two separately rather than with `&&`:

```bash
aireg outdated
aireg update
```

## See also

[`aireg update`](update.md), [`aireg list`](list.md), [CLI reference](index.md)
