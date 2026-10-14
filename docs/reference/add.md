# aireg add

Install artifacts from a registry.

## Synopsis

```text
aireg add <registry>[/<namespace>[/[<kind>/]<name>[@<version>]]] [options]
aireg add <namespace>[/<name>]... --registry <registry> [options]
aireg add <address> [-s <name>]... [--as <name>] [options]
aireg add
```

## Description

`aireg add` installs artifacts into the current project, or with `-g` into your user scope, and records them in the scope's manifest and lockfile. It also installs the versions each artifact's [dependencies](kinds.md#dependencies) name, which only the lockfile records. A dependency that a whole namespace or registry also takes installs at the version its dependents need; one you name yourself has to agree with them, or `add` stops and says which needs what. Each artifact is stored once in the scope and linked into every harness folder, such as `.claude/skills/`.

What you name says what to install: a registry, a namespace in it, or one artifact by its full name.

| You name | Installs |
|---|---|
| `acme` | Everything the `acme` registry publishes. On a terminal, aireg asks which. |
| `acme/engineering` | Everything in the `engineering` namespace, including what it publishes later. |
| `acme/engineering/pr-review` | One artifact. |
| `acme/engineering/pr-review@1.2.0` | One artifact, pinned to version 1.2.0. |
| `acme/engineering/skill/pr-review` | One artifact, when a skill and an agent share the name. |

`acme` here is a registry you declared with [`aireg registry add`](registry.md#aireg-registry-add). You can also name a registry by its address, such as `github.com/acme/ai-registry` or `../acme-registry`. aireg declares it for you, under the name in its `registry.json` or `--as`.

A link or a folder can point at one artifact inside a registry: its folder, `artifacts/<namespace>/<kind>/<name>`, or a version folder inside that. aireg walks up to the folder that holds `registry.json`, declares that registry under the name in its `registry.json` or `--as`, and adds exactly that artifact, pinned when the link or folder is a version folder. A link to a file inside a version folder adds that version.

| Link or folder | Installs |
|---|---|
| `https://github.com/acme/tools/tree/main/registry/artifacts/engineering/skill/pr-review` | `pr-review` from the registry in the `registry` folder of that repository, at `main`. |
| `../acme-registry/artifacts/engineering/skill/pr-review/1.2.0` | `pr-review`, pinned to version 1.2.0. |

A folder that no `registry.json` sits in or above, or a folder inside a registry that is not an artifact's, is refused.

To install from a registry without declaring it first, give its address with `--registry` and write the rest of the full name on its own: `aireg add engineering/pr-review --registry github.com/acme/ai-registry`.

`-s` picks inside what you named: after `acme/engineering`, `-s pr-review` means `engineering/pr-review`. A name that two namespaces share is refused, with the full names that tell them apart.

A version goes only on a single artifact's full name. Adding an artifact that is already installed, at another version, moves its pin. Adding it without a version removes the pin and installs the newest version straight away. Pinning one artifact of a whole registry or namespace you installed works the same way. Either way `add` says it pinned or unpinned the artifact, even when the version installed stays the same, and says `Rolled back` rather than `Updated` when the pin moves it to an older version.

A coding agent finds each skill and agent by its name, so two can't install under one. When an artifact you add would take a name another one already has, aireg installs it under its namespace and name instead, such as `ops-review`, and says so. The one you already had keeps its name. Set [`defaults.name-collision`](config.md#settings) to `report` to leave the new one out, or to `fail` to install nothing.

### Questions

On a terminal, `add` asks what to install, which scope to install into when the folder has no `.registry/manifest.yml`, which harnesses to install into, and whether to link or copy, then asks you to confirm the install, with each artifact and the harnesses that load it. It asks nothing when you name a namespace or an artifact, pass `--select`, or pass `--yes`. See [When aireg asks questions](options.md#when-aireg-asks-questions).

Without a terminal, `add` installs everything you named, but refuses to install more than 10 artifacts unless you pass `--select` or `--all`. For a namespace, only its own artifacts count.

### Scope

Inside a project, `add` installs into the project. Outside a project it installs into your user scope and says so. When `add` asks questions and the folder has no `.registry/manifest.yml`, it asks which of the two to use. `-g` always picks your user scope.

An install into your user scope is kept current in the background: aireg checks the registry every 15 minutes and takes new versions, except of an artifact you pinned, which stays at its version. Pass `--no-auto-update` to skip this. To keep it running after you log out and back in, run [`aireg daemon autostart on`](daemon.md#aireg-daemon-autostart).

### What you trust

Adding a registry trusts whoever publishes to it. Skills and agents are instructions your agent reads, but a plugin can also carry hooks, MCP servers, LSP servers or monitors, which a harness starts by itself and runs as you. `add` names these after it installs such a plugin, and [`aireg show`](show.md) names them before you install it. A registry kept current in the background installs new versions without asking, including any of these a new version adds, so pin a version or pass `--no-auto-update` for a registry you have not reviewed.

## Options

| Option | Description |
|---|---|
| `-r`, `--registry <registry>` | The registry to install from, by name or address. What you name is then the part of the full name after the registry. |
| `-s`, `--select <name>` | The artifacts or namespaces to take from inside what you named, such as `pr-review` or `engineering/pr-review`. Repeat it, or separate names with commas. |
| `--all` | Take everything you named, without asking. |
| `--for <harness>[,<harness>...]` | The harnesses to install these artifacts into. Recorded for these artifacts when it differs from the scope's harnesses. |
| `--copy` | Copy into each harness folder instead of linking. The manifest records `copy: true` on the entry, so later commands keep the copy. An edit to the copy shows in [`aireg status`](status.md), and `update` and `remove` leave it alone unless you pass `--force`. |
| `--as <name>` | The name to save the registry under. |
| `--ref <ref>` | For a git registry, the branch, tag or commit to read. |
| `--path <folder>` | For a git registry, the folder in the repository that holds the registry. |
| `--adapter <id>` | The adapter that reads the registry, when aireg can't tell from the address. Recorded in the manifest. |
| `--config <key>=<value>` | A setting for that adapter, recorded with the registry in the manifest. Repeat it for more than one. A setting the adapter doesn't take is refused: git takes `ref` and `path`, and a local folder takes none. |
| `--no-auto-update` | Don't keep a user-scope install current in the background. |

`add` also takes `-g`, `-y`, `--dry-run`, `--frozen` and `--force`. See [Command options](options.md#command-options).

## JSON output

```json
{"ok": true, "data": {"registry": "acme", "artifacts": ["acme/engineering"], "dependencies": {}, "dryRun": false, "changed": 4, "installed": ["engineering/pr-review"], "kept": []}}
```

`artifacts` holds the full names added to the manifest. `dependencies` maps each artifact installed only because others depend on it to their names. `changed` counts the changes made, `installed` names the artifacts linked into a harness, and `kept` the links not made because something of yours is already there. With `--dry-run`, `changed` and `installed` say what would be done, and `kept` is empty. `jobId` is the background job that keeps a user-scope install current, when there is one. `renamed` lists what was installed under another name because its own is taken: the `artifact`, the name it took (`as`), and the one that has its name (`by`). `unlinked` lists what wasn't installed because its name is taken: the `artifact`, the one that has the name (`by`), and where (`at`).

## Exit status

- `0`: installed, nothing to do, or canceled at a question.
- `1`: the registry isn't declared, the registry publishes nothing, a name, version, namespace or dependency doesn't exist, two artifacts need different versions of one dependency, the manifest names an unknown harness, or a file doesn't match what its version describes.
- `2`: nothing was named and aireg can't ask, more than 10 artifacts would be installed without `--select` or `--all`, a folder has no `registry.json` in or above it or names no artifact inside one, a name matches more than one artifact, another artifact already has the name it would take and `defaults.name-collision` is `report` or `fail`, `--as` isn't a valid name, the name already belongs to another address, or `--for` names an unknown harness.
- `3`: `--frozen` was passed and the install would change the lockfile or the manifest, or an artifact wasn't installed because its name is taken and `defaults.name-collision` is `report`.

## Examples

Install a team's namespace into this project:

```bash
aireg add acme/engineering
```

Install one artifact, pinned to a version:

```bash
aireg add acme/engineering/pr-review@1.2.0
```

Install a namespace for yourself, in every project:

```bash
aireg add -g acme/engineering
```

Install two skills from a namespace:

```bash
aireg add acme/engineering -s pr-review -s lint
```

Install from a registry you haven't declared:

```bash
aireg add github.com/acme/ai-registry --as acme
```

Install one artifact from a registry you haven't declared:

```bash
aireg add engineering/pr-review --registry github.com/acme/ai-registry
```

Install one artifact from a link to its folder in a registry:

```bash
aireg add https://github.com/acme/ai-registry/tree/main/artifacts/engineering/skill/pr-review
```

## See also

[`aireg search`](search.md), [`aireg remove`](remove.md), [`aireg install`](install.md), [`aireg update`](update.md), [`aireg show`](show.md), [`aireg registry`](registry.md), [CLI reference](index.md)
