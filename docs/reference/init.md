# aireg init

Set up a project (creates .registry/manifest.yml).

## Synopsis

```text
aireg init [--for <target>[,<target>...]] [--force]
aireg init --registry <registry> [--as <name>] [--publish-to <registry>/<namespace>]
           [--watch] [--import <target>[,<target>...] | all] [--for <target>,...] [--force]
```

## Description

`aireg init` writes `.registry/manifest.yml` in the current folder, recording the targets the project installs into. It also writes `.registry/.gitignore`, which keeps the files of yours that aireg moves aside out of git. It doesn't edit the project's own `.gitignore`. Commit `.registry/` so everyone working on the project installs the same artifacts.

`init` always writes into the current folder. Run it at the root of the project.

With `--registry`, `init` sets up the whole project in one go. It:

1. Declares the registry, as [`aireg registry add`](registry.md#aireg-registry-add) does.
2. Installs everything the registry publishes.
3. Imports the artifacts already in your target folders, if you pass `--import`.
4. Publishes anything you edited locally to the registry, without asking.
5. Adds a background job that keeps the project in sync every 15 minutes, if you pass `--watch`.

Your user scope needs no setup: install into it directly with `aireg add -g`.

## Options

| Option | Description |
|---|---|
| `--for <target>[,<target>...]` | The [targets](options.md#targets) the project installs into. Defaults to `claude-code,codex`. |
| `--force` | Replace an existing manifest. The registries it declares are kept; the artifacts it lists are not. |
| `--registry <registry>` | The registry to set the project up from. Takes any address [`aireg registry add`](registry.md#aireg-registry-add) does. |
| `--as <name>` | The name to give the registry. Defaults to the name in its `registry.json`, or the last part of its address for one that can't be read before you sign in. Used with `--registry`. |
| `--publish-to <registry>/<namespace>` | Where [`aireg publish`](publish.md) sends work from this machine when no destination is named. Used with `--registry`. It sets `defaults.namespace` for every project on this machine; clear it with [`aireg config unset defaults.namespace`](config.md). |
| `--watch` | Keep the project in sync with the registry in the background, every 15 minutes. Used with `--registry`. |
| `--adapter <id>` | The adapter that reads the registry, when aireg can't tell from the address. Used with `--registry`. |
| `--token-stdin` | Read the registry's token from standard input and sign in with it. Used with `--registry`. |
| `--import <target>[,<target>...] | all` | Copy the artifacts already in these target folders into the project, so aireg manages them. Each original stays where it is, and its target keeps loading it from there. An artifact holding a symlink, or a file that may hold credentials, is refused as `publish` refuses it, and nothing is imported. Takes `claude-code`, `codex`, `universal` (or their aliases `claude` and `agents`) or `all`. Needs `--registry`. |

## JSON output

```json
{"ok": true, "data": {"manifest": "/path/to/project/.registry/manifest.yml", "scope": "project", "targets": ["claude-code", "codex"], "imported": 0, "next": ["aireg registry add <address> --as <name>", "aireg add <name>/<namespace>"]}}
```

`next` holds the commands to run next. With `--registry`, `init` runs them itself, so the one JSON document it prints has `steps` in place of `next`, one entry for each step it took:

```json
{"ok": true, "data": {"manifest": "/path/to/project/.registry/manifest.yml", "scope": "project", "targets": ["claude-code", "codex"], "imported": 0, "steps": [{"name": "registry", "detail": "acme → github.com/acme/ai-registry"}, {"name": "pulled", "detail": "3 artifacts from acme"}]}}
```

The steps are `signed in`, `registry`, `namespace`, `pulled`, `imported`, `published` and `watching`, each only when it happened.

## Exit status

- `0`: the manifest was written.
- `1`: the manifest already exists (pass `--force` to replace it).
- `2`: `--for` names an unknown target, `--as`, `--import` or `--publish-to` has a value that isn't valid, an argument or `-g` was passed, `init` was run in your home folder, or `--import` has no single registry to import into.

With `--registry`, `init` exits with the status of the first step that fails. Run the same command again once it is fixed: while the manifest still installs nothing, `init` carries on from where it stopped.

## Examples

Set up a project that installs into Claude Code and Codex:

```bash
aireg init
```

Set up a project that installs into Claude Code and Cursor:

```bash
aireg init --for claude-code,cursor
```

Set up a project from a team registry and keep it in sync:

```bash
aireg init --registry github.com/acme/ai-registry --as acme --watch
```

## See also

[`aireg registry`](registry.md), [CLI reference](index.md)
