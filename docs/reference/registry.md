# aireg registry

Declare the registries you install from, or create and check one of your own.

## Synopsis

```text
aireg registry add <address> [--as <name>] [--ref <ref>] [--path <folder>] [--adapter <id>] [--config <key>=<value>]... [-g] [--dry-run]
aireg registry list [-g]
aireg registry show [<registry>] [-g]
aireg registry remove <registry> [-g] [--dry-run]

aireg registry init [<folder>] [--name <name>] [--description <text>] [--namespace <namespace>]... [-y]
aireg registry index [<folder>]
aireg registry validate [<folder>] [--base <ref>]
```

`aireg registry` on its own runs `aireg registry list`.

## Description

The first four actions manage the registries a project or your user scope installs from. Each is declared once under a short name, which [`aireg add`](add.md) and the other commands use from then on. Declarations are written to the `manifest.yml` of the project, or of your user scope with `-g`.

The last three actions work on a registry you publish: a folder, usually a git repository, laid out as the [file spec](https://github.com/atlanai/ai-registry/blob/main/spec/file-spec.md) describes.

### Addresses

A registry's address is where it lives. It can be:

- a GitHub repository, such as `github.com/acme/ai-registry`
- a git URL, such as `https://github.com/acme/ai-registry.git` or `ssh://git@github.com/acme/ai-registry.git`, over `https`, `ssh` or `file`. A `git://` or plain `http://` address is refused, since neither has transport security; `http://` is allowed only on this machine, such as `http://localhost:8080/acme`.
- a link to a folder in a GitHub repository, such as `https://github.com/acme/ai-registry/tree/main/registries/platform`, which sets the branch and folder for you
- a folder on this machine, such as `../acme-registry` or `~/registries/acme`. A relative path is recorded relative to the project.

## Options

Each action's own options are listed with it below. `add`, `list`, `show` and `remove` also take `-g`, to act on your user scope, and `add` and `remove` take `--dry-run`. See [Command options](options.md#command-options).

## aireg registry add

Declares a registry. aireg reads it first, to check it can, then records it in the manifest. Nothing is installed until you run [`aireg add`](add.md).

| Option | Description |
|---|---|
| `--as <name>` | The name to declare it under: lowercase letters, digits and hyphens, as for a namespace. Defaults to the name in the registry's `registry.json`, or else the last part of its address. |
| `--ref <ref>` | For a git registry, the branch, tag or commit to read. |
| `--path <folder>` | For a git registry, the folder in the repository that holds the registry. |
| `--adapter <id>` | The adapter that reads the registry, when aireg can't tell from the address. Recorded in the manifest. |
| `--config <key>=<value>` | A setting for that adapter, recorded with the registry in the manifest. Repeat it for more than one. A setting the adapter doesn't take is refused: git takes `ref` and `path`, and a local folder takes none. |
| `-g` | Declare it in your user scope. Outside a project, the user scope is used anyway, and aireg says so. |
| `--dry-run` | Print what would be declared, and change nothing. |

Declaring a name that already belongs to another address fails; choose another with `--as`, or remove the old one first.

JSON output: `{"ok": true, "data": {"registry": "acme", "address": "github.com/acme/ai-registry", "config": {}, "readable": true, "dryRun": false}}`. `readable` is `false` when the registry could not be read before you sign in.

## aireg registry list

Lists the registries this project declares, or with `-g` the ones your user scope declares. The two aren't merged. `ls` is the same command.

The table shows each registry's name, its address, its `ref` and `path` when set, and the artifacts installed from it.

JSON output: `{"ok": true, "data": {"scope": "project", "registries": [{"registry": "acme", "address": "github.com/acme/ai-registry", "config": {}}]}}`. A registry declared with `--adapter` also has `adapter`.

## aireg registry show

Prints what a registry publishes, without installing anything: its name, with the commit for a git registry, its address, its layout and how many artifacts it holds, then each artifact with its kind and description.

The argument is an address or a declared name. With no argument, `show` describes the only registry declared, or the registry you are in when none is declared. The `--ref`, `--path`, `--adapter` and `--config` options of `registry add` also work here, to look at another branch or folder or read through another adapter.

JSON output: `{"ok": true, "data": {"registry": "acme", "address": "...", "revision": "...", "layouts": ["git"], "entries": [...], "warnings": [...]}}`. `revision` is the commit read, for a git registry only. `layouts` names how the registry was read, such as `git` or `local` for a folder. Each entry has its `name`, `kind`, `namespace`, `path` and `description`, the `version` the registry serves, which `@<version>` pins, and `engine` when the artifact names the oldest aireg that can install it, in `engines.aireg` in its front matter.

## aireg registry remove

Removes a registry's declaration from the manifest. `rm` is the same command.

`remove` refuses while an artifact installed from that registry remains. Uninstall those first with [`aireg remove`](remove.md).

| Option | Description |
|---|---|
| `-g` | Remove it from your user scope. |
| `--dry-run` | Print what would be removed, and change nothing. |

JSON output: `{"ok": true, "data": {"registry": "acme", "dryRun": false}}`.

## aireg registry init

Creates a registry in `<folder>`, or in the current folder. The folder is created if it doesn't exist. Run it in a clone; a remote address is refused.

It writes `registry.json`, an empty `index.json`, and an `artifacts/<namespace>/` folder for each namespace. If the folder is already a registry, `init` only adds the folders of the namespaces you name that it doesn't have yet, and changes nothing else.

| Option | Description |
|---|---|
| `--name <name>` | The registry's name. Defaults to the owner of the git `origin` remote, or else the folder's name. |
| `--description <text>` | A one-line description of the registry. |
| `--namespace <namespace>` | A namespace to create, in lowercase letters, digits and hyphens. Repeat it for more than one. |
| `-y` | Ask nothing and take the defaults. |

On a terminal, `init` asks for each value you didn't pass.

JSON output: `{"ok": true, "data": {"root": "...", "created": true, "slug": "acme", "namespaces": ["engineering"]}}`. In a folder that is already a registry, `created` is `false` and `namespaces` lists only the ones it added.

## aireg registry index

Checks the registry, then indexes every version folder that isn't indexed yet. For each new version it writes `artifact.json`, with the kind's own document as `spec` and a digest for every file but VCS and OS files such as `.git` and `.DS_Store`, and updates the artifact's `versions.json` and the registry's `index.json`. Versions already indexed are never rewritten.

`index` also keeps each artifact's `latest` on its newest active release. A status change is the one edit you make to `versions.json` by hand: after you set a version's `"yanked": true`, or its `status` to `deprecated` or `archived`, run `index` to move `latest` off it and update the row's `catalog_digest`, if it has one. `index` lists a new version above the ones before it. A prerelease such as `1.0.0-rc.1` becomes `latest` only while the artifact has no release.

`index` works in the registry that holds `<folder>`, or the current folder. If the registry has problems, it lists them and indexes nothing. In a git repository, it ends with the commit command to release what it indexed. Create artifacts to index with [`aireg skill new`](kinds.md).

JSON output: `{"ok": true, "data": {"root": "...", "added": [...], "moved": [...], "paths": [...]}}`. `moved` lists the artifacts whose `latest` moved without a new version.

## aireg registry validate

Checks a registry against the file spec and reports every problem it finds, each with how to fix it. It checks that:

- `registry.json` can be read and lists the `files` capability, and `index.json` is current
- `index.json` and each `versions.json` agree on every artifact's `latest` and digest, every artifact `index.json` lists has a `versions.json`, each `versions.json` names the folder it is in, and `latest` is the newest active release
- every version a `versions.json` lists, yanked or not, still has its folder
- each artifact is of a kind the registry holds, has the files that kind needs, and holds no symlink and no file that may hold credentials
- each artifact's front matter is valid, has no `TODO` left in it, and its `name` matches its folder
- each [dependency](kinds.md#dependencies) names a version the registry holds
- each locally served kind manifest satisfies the manifest schema and JSON Schema Draft 2020-12, with its local references resolved
- no released version was changed or deleted after it was released, and every released version is still listed in `versions.json` with its digest. To withdraw a release, set `"yanked": true` on it in `versions.json` instead.

A released version stays as it was released, so a change to one goes into a new version. When the edited release is the newest, `validate` prints the three commands that do this, which you run from the registry's root: `aireg skill bump lint --namespace engineering` copies the edited files into the next version, `git checkout origin/main -- artifacts/engineering/skill/lint/0.1.0` restores the release from the base, and `aireg registry index` records the new version. For an older release, restore it first, then make the change again in the version `bump` starts from the newest. Without `--base`, the commands restore from the last commit, `HEAD`.

| Option | Description |
|---|---|
| `--base <ref>` | A git ref to compare released versions against, such as `origin/main`. It must name a commit. |

Run `validate` to check a change before you release it.

Kind validation uses the full Draft 2020-12 validation vocabulary, with `format` treated as an
annotation. It preserves input values. Schema references must resolve within the registry;
external schemas are never downloaded. Agent cards retain their display name, while their
wrapper uses the registry slug. Agent versions must have exactly one native entry file.

The CLI does not enforce the kind manifest's relationship-kind restrictions, cardinality,
search and embedding pointers, attachment or governance flags, or schema revision negotiation.
These annotations describe future consumers; they do not change what this command guarantees.

It also warns about a kind named like one of aireg's commands, which that command hides. A warning doesn't change the exit status.

JSON output: `{"ok": true, "data": {"name": "acme", "namespaces": 1, "artifacts": 4, "versions": 6, "problems": [], "warnings": []}}`. `ok` is `false` when there are problems.

## Exit status

- `0`: success. For `validate`, the registry has no problems.
- `1`: the registry can't be read, no registry has that name, the registry is still in use, `--base` names no commit, or, for `validate` and `index`, the registry has problems.
- `2`: `add` or `remove` was given no address or name, `--as` isn't a valid name, the name already belongs to another address, `show` was given no argument and the scope declares no registry or more than one, the action is unknown, `index` or `validate` is run outside a registry, `init` is given a remote address or a namespace that isn't valid, or `--base` is given a value that starts with `-`.

## Examples

Declare a team registry for this project, then install from it:

```bash
aireg registry add github.com/acme/ai-registry --as acme
aireg add acme/engineering
```

Declare a registry for yourself, in every project:

```bash
aireg registry add github.com/acme/ai-registry -g
```

See what a registry publishes:

```bash
aireg registry show acme
```

Create a registry with one namespace:

```bash
mkdir acme-registry && cd acme-registry && git init
aireg registry init --name acme --namespace engineering -y
```

Release a new version: check it, index it and commit it:

```bash
aireg registry index
git add . && git commit -m "release pr-review 1.3.0"
```

Check a change against the main branch before you release it:

```bash
aireg registry validate --base origin/main
```

## See also

[`aireg init`](init.md), [`aireg add`](add.md), [CLI reference](index.md)
