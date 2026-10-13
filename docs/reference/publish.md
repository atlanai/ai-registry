# aireg publish

Publish artifacts to a registry, as new versions.

## Synopsis

```text
aireg publish [<path> | <glob> | <name>]... [--to <registry>/<namespace>[/<name>[@<version>]]]
              [--to <folder>/<namespace>]
              [--bump patch | minor | major] [-m <message>] [--changed-since <commit>]
              [-g] [-y] [--dry-run] [--force]
```

## Description

`aireg publish` sends skills and agents to a registry as new versions. Each argument can be:

- a path to a skill folder (a folder holding `SKILL.md`) or to an agent's `.md` file
- a glob over paths, such as `'.claude/skills/*'`
- the name of an installed artifact, to publish the edits you made to it

With no arguments, `publish` takes the work edited in this scope: installed artifacts you changed, and skills and agents in your harness folders that no registry has yet. On a terminal it asks which to publish. Without a terminal, pass `--yes` to publish all of them.

### Where it goes

For each artifact, `publish` uses the first of these that applies:

1. `--to`
2. The registry and namespace an installed artifact came from
3. The default set with `aireg config set defaults.namespace <registry>/<namespace>`, if this scope declares that registry
4. On a terminal, it asks, offering only the registries that accept a publish

The registry must be declared in the project or your user scope. See [`aireg registry add`](registry.md#aireg-registry-add). A path names a registry folder instead, such as `--to ../acme-registry/engineering`, and needs no declaration.

### Versions

A first publish is version `0.1.0`. After that, `publish` takes the next patch version, or the version `--bump` names. To publish an exact version, add it to `--to`, such as `--to acme/engineering/pr-review@2.0.0`. A published version is never rewritten. After a version that isn't SemVer, such as `1`, there is no next version to work out, so `publish` asks you to name one.

An artifact whose files match the newest published version is listed as `same` and not sent. On a terminal, when an artifact changed and you didn't pass `--bump`, `publish` asks how big a change it is.

Before sending, `publish` lists each artifact as `add`, `update` with its old and new version, or `same`, and asks to confirm. It refuses a skill that [`aireg registry validate`](registry.md#aireg-registry-validate) would reject.

### What it sends

Everything in the artifact's folder is published, except version-control folders, OS files such as `.DS_Store`, and `node_modules/`. A file that may hold credentials is refused, with its path, rather than published: `.env` and `.env.*` (but not `.env.example`, `.env.sample` or `.env.template`), `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`, `credentials.json`, SSH private keys such as `id_rsa`, and `*.pem`, `*.key`, `*.p12` and `*.pfx` files. Move such a file out of the folder before publishing. A [watch job](job.md) applies the same rules, and never offers an artifact a registry installed, linked or copied, as your own work.

### Git registries

aireg doesn't publish to a registry in a git repository. Without `--to`, when every declared registry is a git one, `publish` says so before asking anything. Publish into your clone of it, then commit and push with git:

```bash
aireg publish .claude/skills/triage --to ../acme-registry/engineering
```

```text
../acme-registry  /home/me/acme-registry
  add     engineering/skill/triage  0.1.0
✓ Published triage to ../acme-registry.
  next   cd ../acme-registry && git add . && git commit -m "add triage 0.1.0" && git push
```

The `next` line is the git command that commits the new version in the registry's clone and pushes it. Once the change merges, machines that sync with the registry take the new version within 15 minutes, and projects take it with [`aireg update`](update.md).

Into a registry folder, an agent goes in as `AGENT.md`. A coding agent's own file, such as `.claude/agents/reviewer.md`, doesn't say what runs it, so aireg adds `runtime.harness` from the folder it sits in (`claude-code` for `.claude`, `cursor` for `.cursor`), and checks it as `aireg registry validate` would.

## Options

| Option | Description |
|---|---|
| `--to <registry>/<namespace>` | Where to publish. Add `/<name>` to publish one artifact under that name, and `/<name>@<version>` to publish it at an exact version. A path, such as `../acme-registry/engineering`, publishes into that registry folder. |
| `--bump patch | minor | major` | How far to move the version. Defaults to `patch`. |
| `-m`, `--message <message>` | The change message, for a registry that records one. Defaults to a message naming each artifact and its version. A registry folder records none, so put it in your git commit instead. |
| `--changed-since <commit>` | Publish only the artifacts whose files changed since this git commit. The commit must be in the repository's history. |
| `--force` | Publish an edit made on an older version over a newer one published since. |
| `-y`, `--yes` | Publish without asking. With no arguments, publish everything edited here. |
| `--dry-run` | Print what would be published, and send nothing. |

`publish` also takes `-g`. Outside a project it uses your user scope and says so. See [Command options](options.md#command-options).

## JSON output

With `--json`, `publish` asks no questions and prints each artifact with its old and new version, and where it went:

```json
{"ok": true, "data": {"dryRun": false, "artifacts": [{"name": "triage", "kind": "skill", "registry": "acme", "namespace": "engineering", "from": "1.2.0", "version": "1.2.1", "published": true}]}}
```

`registry` is the registry's name, or for `--to <folder>`, the registry folder as `--to` gave it. `from` is `null` for a new artifact, and `published` is `false` for one already published or under `--dry-run`.

## Exit status

- `0`: published, nothing new to publish, a dry run, or canceled at a question.
- `1`: the registry isn't declared, a path isn't a skill or an agent or holds a symlink, nothing matches an argument, a skill would fail `aireg registry validate`, or the version is already published.
- `2`: the registry doesn't accept published work, as a git registry doesn't, `--to` names no namespace or an invalid name, an artifact has nowhere to go, nothing was named without `--yes` and aireg can't ask, `--changed-since` names a commit that isn't in the repository, or a `--to` path isn't inside a registry folder.
- `3`: the artifact was edited from an older version than the one published since. Install the newer version and redo the edit, or pass `--force`.

## Examples

Publish a skill to a team registry:

```bash
aireg publish .claude/skills/triage --to acme/engineering
```

Publish a new minor version of an installed skill you edited:

```bash
aireg publish pr-review --bump minor
```

Publish every skill in a repository, without asking:

```bash
aireg publish '.claude/skills/*' --to acme/engineering --yes
```

Publish only what changed in the last commit:

```bash
aireg publish '.claude/skills/*' --to acme/engineering --changed-since HEAD~1 --yes
```

## See also

[`aireg sync`](sync.md), [`aireg skill`](kinds.md), [`aireg registry`](registry.md), [`aireg status`](status.md), [CLI reference](index.md)
