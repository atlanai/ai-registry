# aireg add

Install artifacts from a registry.

## Synopsis

```text
aireg add <registry>[/<namespace>[/[<kind>/]<name>[@<version>]]] [options]
aireg add <namespace>[/<name>]... --registry <registry> [options]
aireg add <address> [-s <name>]... [--as <name>] [options]
aireg add --from <file> [options]
aireg add
```

## Description

`aireg add` installs artifacts into the current project, or with `-g` into your user scope, and records them in the scope's manifest and lockfile. It also installs the versions each artifact's [dependencies](kinds.md#dependencies) name, which only the lockfile records. A dependency that a whole namespace or registry also takes installs at the version its dependents need; one you name yourself has to agree with them, or `add` stops and says which needs what. Each artifact is stored once in the scope and linked into every target folder, such as `.claude/skills/`.

What you name says what to install: a registry, a namespace in it, or one artifact by its full name.

| You name | Installs |
|---|---|
| `acme` | Everything the `acme` registry publishes. On a terminal, aireg asks which. |
| `acme/engineering` | Everything in the `engineering` namespace, including what it publishes later. |
| `acme/pr-review` | The one artifact named `pr-review`, when `acme` has no namespace of that name. A name two namespaces share is refused, with the full names that tell them apart. The manifest records the full name. |
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

`-s` picks inside what you named: after `acme/engineering`, `-s pr-review` means `engineering/pr-review`. After a plugin, such as `acme-tools/docs-kit`, `-s pdf` installs that one skill on its own, filed under the plugin's name, rather than the whole plugin. A name that two namespaces share is refused, with the full names that tell them apart, and so is a name that is both a plugin and an artifact.

Each version has a status in its registry. A `blocked` version never installs, even pinned, a `draft` installs only pinned, and a `deprecated` one installs with a warning; see [Version status](kinds.md#version-status).

A version goes only on a single artifact's full name. Adding an artifact that is already installed, at another version, moves its pin. Adding it without a version removes the pin and installs the newest version straight away. Pinning one artifact of a whole registry or namespace you installed works the same way. Either way `add` says it pinned or unpinned the artifact, even when the version installed stays the same, and says `Rolled back` rather than `Updated` when the pin moves it to an older version.

A coding agent finds each skill and agent by its name, so two can't install under one. When an artifact you add would take a name another one already has, aireg installs it under its namespace and name instead, such as `ops-review`, and says so. The one you already had keeps its name. Set [`defaults.name-collision`](config.md#settings) to `report` to leave the new one out, or to `fail` to install nothing.

### Sources that are not registries

`add` also installs from sources that aren't registries, and records exactly what it installed in the lockfile, as it does for a registry. aireg only reads them, and never publishes to them.

| Source | Example |
|---|---|
| A folder or git repository of skills and agents | `aireg add github.com/acme/skills --all` |
| A plugin marketplace, or a plugin's own manifest | `aireg add github.com/acme/plugins --all` |
| A site's Agent Skills index | `aireg add https://example.com --all` |

A source with a `registry.json` is always a registry, and one whose `registry.json` is broken is an error rather than a folder of skills.

A folder, or a git repository, that holds skills and agents but no `registry.json` is read as a folder of skills. aireg looks for:

- a `SKILL.md` at the top, which makes the whole source one skill
- otherwise, folders holding a `SKILL.md` up to three levels down, such as `pdf/`, `skills/pdf/`, `skills/<group>/pdf/`, `.claude/skills/pdf/` or `.agents/skills/pdf/`. It doesn't look inside a skill it found, or in `node_modules`, `dist`, `build` or hidden folders other than `.claude` and `.agents`.
- agents, as `agents/*.md` and `.claude/agents/*.md`

A skill is named after its folder and an agent after its file; front matter gives the description. Each is filed under a namespace named after the source, such as `skills-repo` for `github.com/acme/skills-repo`, except that `skills/<group>/<name>` is filed under `<group>`. When two skills, or two agents, in one namespace share a name, the first in path order installs, with a warning. A symlink is never followed: aireg skips it, and says so. Installed from a whole source, each keeps its plain name, such as `pdf`.

A git repository is read at one commit, recorded in the lockfile. Without `--ref`, that is the newest release tag, such as `v1.2.0`, or the default branch when there is none. Each artifact's version is the tag on that commit, an artifact's own tag such as `pdf/v1.2.0` winning over the repository's, or else a pseudo-version such as `1.2.1-0.20261019120000-4e1d2c9a8b7f`, made from the newest tag before it, the commit's time and its first 12 characters. `@<version>` takes either, so a pseudo-version pins its commit. Everything installed from one repository moves together, so `aireg update` on one of them updates them all. A folder on this machine has no versions: what it holds now is what installs, and `@<version>` is refused.

A plugin marketplace is read from `.claude-plugin/marketplace.json`, or else `.agents/plugins/marketplace.json`; when both are there and list different plugins, aireg reads the first and says so. A folder with only a plugin manifest, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` or an Agent Plugins `plugin.json`, is a marketplace of one. Each plugin installs whole, as a plugin, and its skills and agents are filed under the plugin's name. A plugin is named after its marketplace entry, the name Claude Code installs it by, and its own manifest's name still prefixes its commands and skills. aireg reads a plugin's components as Claude Code does: its marketplace entry is its manifest when it has none of its own, an entry adds components to its own unless it sets `"strict": false`, and `skills/`, `agents/`, `commands/`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `monitors/` and `bin/` are where it looks by default. A plugin whose source is a relative path, or a bare name under `metadata.pluginRoot`, installs from the marketplace's own files. In a marketplace aireg reads with git, a `github`, `url` or `git-subdir` source is fetched with git too, over `https`, `ssh` or `file`, each plugin at a commit of its own: its `sha`, which wins over `ref`, or else the newest commit on `ref`. The lockfile records that commit, so `install` keeps it and `update` moves it. A source of any other type, such as `npm`, `archive` or `command`, is skipped with a warning, and a `command` is never run.

A plugin from a source that is not a registry and that carries hooks, MCP servers, LSP servers, monitors or `bin/` installs only once you trust it: on a terminal `add` asks, and otherwise it is left out, the rest installs, and `add` prints the `--trust <plugin>` that takes it. An `add` that installs nothing else leaves the manifest as it was. The manifest records the plugins you trust. A sync or background job never takes a new version of a plugin that adds or changes what it runs; it reports it, and `aireg update <plugin>` takes it.

A site's web address, such as `https://example.com`, is read as its Agent Skills index, `/.well-known/agent-skills/index.json` in the 0.2.0 format: aireg looks beside the address first, then at the site's root, and refuses the older `/.well-known/skills/` index, which has no digests. Each skill installs only once its bytes match the digest the index gives; one that doesn't stops the whole add, and nothing from the site installs. An archive is a `.tar.gz` or `.zip` of at most 1000 files and 50 MB, holding no links and no path that leaves it. A skill on another host is fetched over `https` only. aireg sends the site no credentials, and a site's skills have no versions. The addresses of GitHub, GitLab and Bitbucket, and any address ending in `.git`, stay git repositories; for any other git server, pass `--adapter git`.

aireg tells how to read a source from what it holds, once, and records anything other than a registry, `layout: folder`, `layout: marketplace` or `layout: well-known`, with the source in the manifest. `--layout` says it instead.

### Skills another installer recorded

`aireg add --from <file>` adds the skills a lock file another skill installer wrote records, such as a project's `skills-lock.json` or a user's `~/.agents/.skill-lock.json`. aireg reads only where each skill came from: its source, of type `github`, `gitlab`, `git` or `well-known`, its `ref`, and the folder its `skillPath` names. It adds each source the way `add` adds any address, and skips an entry it cannot read, saying why. A user's file installs into your user scope unless you pass a scope.

A copy already on disk where a skill would go, holding exactly what aireg installs, is taken over as aireg's own and never rewritten. One that differs reads as edited and stays as it is. A skill installs under the name of its folder, so a copy under another name stays as it is too. Running it again changes nothing.

### Questions

On a terminal, `add` asks what to install, which scope to install into when the folder has no `.registry/manifest.yml`, which targets to install into, and whether to link or copy, then asks you to confirm the install, with each artifact and the targets that load it. It asks nothing when you name a namespace or an artifact, pass `--select`, or pass `--yes`. See [When aireg asks questions](options.md#when-aireg-asks-questions).

Without a terminal, `add` installs everything you named, but refuses to install more than 10 artifacts unless you pass `--select` or `--all`. For a namespace, only its own artifacts count.

### Scope

Inside a project, `add` installs into the project. Outside a project it installs into your user scope and says so. When `add` asks questions and the folder has no `.registry/manifest.yml`, it asks which of the two to use. `-g` always picks your user scope.

An install into your user scope is kept current in the background: aireg checks the registry every 15 minutes and takes new versions, except of an artifact you pinned, which stays at its version. Pass `--no-auto-update` to skip this. To keep it running after you log out and back in, run [`aireg daemon autostart on`](daemon.md#aireg-daemon-autostart).

### What you trust

Adding a registry trusts whoever publishes to it. Skills and agents are instructions your agent reads, but a plugin can also carry hooks, MCP servers, LSP servers, monitors or executables in `bin/`, which a coding agent starts by itself and runs as you. `add` names these after it installs such a plugin, and [`aireg show`](show.md) names them before you install it. A registry kept current in the background installs new versions without asking, including any of these a new version adds, so pin a version or pass `--no-auto-update` for a registry you have not reviewed.

## Options

| Option | Description |
|---|---|
| `-r`, `--registry <registry>` | The registry to install from, by name or address. What you name is then the part of the full name after the registry. |
| `-s`, `--select <name>` | The artifacts or namespaces to take from inside what you named, such as `pr-review` or `engineering/pr-review`. Repeat it, or separate names with commas. |
| `--all` | Take everything you named, without asking. |
| `--for <target>[,<target>...]` | The targets to install these artifacts into. Recorded for these artifacts when it differs from the scope's targets. |
| `--copy` | Copy into each target folder instead of linking. The manifest records `copy: true` on the entry, so later commands keep the copy. An edit to the copy shows in [`aireg status`](status.md), and `update` and `remove` leave it alone unless you pass `--force`. |
| `--as <name>` | The name to save the registry under. |
| `--ref <ref>` | For a git registry, the branch, tag or commit to read. |
| `--path <folder>` | For a git registry, the folder in the repository that holds the registry. |
| `--adapter <id>` | The adapter that reads the registry, when aireg can't tell from the address. Recorded in the manifest. |
| `--layout <layout>` | How to read the source, `registry`, `marketplace`, `well-known` or `folder`, instead of telling from what it holds. Recorded in the manifest. See [Sources that are not registries](#sources-that-are-not-registries). |
| `--config <key>=<value>` | A setting for that adapter, recorded with the registry in the manifest. Repeat it for more than one. A setting the adapter doesn't take is refused: git takes `ref` and `path`, and a local folder takes none. |
| `--from <file>` | Add the skills another installer's lock file records. See [Skills another installer recorded](#skills-another-installer-recorded). |
| `--trust <plugin>` | Install this plugin from a source that is not a registry although it carries hooks, servers or executables that run as you, and record that in the manifest. Repeat it for more than one. |
| `--no-auto-update` | Don't keep a user-scope install current in the background. |

`add` also takes `-g`, `-y`, `--dry-run`, `--frozen` and `--force`. See [Command options](options.md#command-options).

## JSON output

```json
{"ok": true, "data": {"registry": "acme", "artifacts": ["acme/engineering"], "dependencies": {}, "dryRun": false, "changed": 4, "installed": ["engineering/pr-review"], "kept": []}}
```

`artifacts` holds the full names added to the manifest. `layout` is `marketplace`, `well-known` or `folder` for a source that is not a registry. `dependencies` maps each artifact installed only because others depend on it to their names. `changed` counts the changes made, `installed` names the artifacts linked into a target, and `kept` the links not made because something of yours is already there. With `--dry-run`, `changed` and `installed` say what would be done, and `kept` is empty. `jobId` is the background job that keeps a user-scope install current, when there is one. `renamed` lists what was installed under another name because its own is taken: the `artifact`, the name it took (`as`), and the one that has its name (`by`). `unlinked` lists what wasn't installed because its name is taken: the `artifact`, the one that has the name (`by`), and where (`at`).

## Exit status

- `0`: installed, nothing to do, or canceled at a question.
- `1`: the registry isn't declared, the registry publishes nothing, a name, version, namespace or dependency doesn't exist, two artifacts need different versions of one dependency, the manifest names an unknown target, or a file doesn't match what its version describes.
- `2`: nothing was named and aireg can't ask, more than 10 artifacts would be installed without `--select` or `--all`, a folder has no `registry.json` in or above it or names no artifact inside one, a name matches more than one artifact, another artifact already has the name it would take and `defaults.name-collision` is `report` or `fail`, `--as` isn't a valid name, the name already belongs to another address, or `--for` names an unknown target.
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
