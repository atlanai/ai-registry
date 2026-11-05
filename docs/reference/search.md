# aireg search

Find artifacts in the registries you have declared.

## Synopsis

```text
aireg search <query> [--registry <registry>] [--kind <kind>] [-g]
```

## Description

`aireg search` looks through what every registry this project declares publishes, and prints the artifacts that match. It installs nothing and doesn't change the manifest. In a project it also searches the registries your user scope declares; with `-g` it searches only those.

A match has every word of the query somewhere in its name, namespace, description or labels, ignoring case. The best matches come first: the exact name, then names that start with the query, then names that contain it, then everything else. Words joined by a space also match a hyphenated name, so `pr review` finds `pr-review`.

Each registry is read the way [`aireg registry show`](registry.md#aireg-registry-show) reads it, from its `index.json` and the files it names. A folder is read from disk, and a git registry from aireg's copy of it once git has checked which commit is current. A registry that can't be read is skipped with a warning, and the others are still searched. When every registry fails, or the one `--registry` names does, `search` fails.

Under the table, `next` is the command that installs the best match.

## Options

| Option | Description |
|---|---|
| `-r`, `--registry <registry>` | Search only this registry, by name or address. |
| `--kind <kind>` | Only artifacts of this kind: `plugin`, `skill`, `agent` or `knowledge`. |
| `-g`, `--user` | Search the registries your user scope declares. |

See [Command options](options.md#command-options).

## JSON output

```json
{"ok": true, "data": {"query": "review", "matches": [{"address": "acme/engineering/skill/pr-review", "registry": "acme", "namespace": "engineering", "kind": "skill", "name": "pr-review", "version": "1.2.0", "description": "Review a pull request...", "labels": {"category": "engineering"}}], "skipped": []}}
```

`address` is the artifact's full name, which `aireg add` takes. Unlike `address` in other commands, it is not where the registry lives. `labels` appears only on an artifact that has them. `skipped` lists each registry that couldn't be read, with its `registry` and `message`.

## Exit status

- `0`: searched, whether or not anything matched.
- `1`: no registry is declared, `--registry` names no declared registry, or none could be read.
- `2`: there is no query, or the kind is unknown.
- `4`: the one registry `--registry` names needs you to sign in.

## Examples

Find everything about review:

```bash
aireg search review
```

Find only agents, only in the registry named acme:

```bash
aireg search lint --kind agent -r acme
```

## See also

[`aireg add`](add.md), [`aireg registry show`](registry.md#aireg-registry-show), [`aireg show`](show.md), [CLI reference](index.md)
