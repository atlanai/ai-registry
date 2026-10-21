# aireg publish

Publish artifacts to a registry, as new versions.

## Synopsis

```text
aireg publish [<path> | <glob> | <name>]... [--to <registry>/<namespace>[/<name>[@<version>]]]
              [--to <folder>/<namespace>]
              [--bump patch | minor | major] [-m <message>] [--changed-since <commit>]
              [-g] [-y] [--dry-run] [--force]
aireg publish [--to <publish target>] [--bump patch | minor | major] [-m <message>]
              [--changed-since <commit>] [-y] [--dry-run] [--force]
```

The second form publishes the manifest's `exports:`; see [Publishing a repository's exports](#publishing-a-repositorys-exports).

## Description

`aireg publish` sends skills and agents to a registry as new versions. Each argument can be:

- a path to a skill folder (a folder holding `SKILL.md`) or to an agent's `.md` file
- a glob over paths, such as `'.claude/skills/*'`
- the name of an installed artifact, to publish the edits you made to it

With no arguments, in a project whose manifest lists `exports:`, `publish` takes those exports, as [Publishing a repository's exports](#publishing-a-repositorys-exports) describes. Otherwise it takes the work edited in this scope: installed artifacts you changed, and skills and agents in your harness folders that no registry has yet. On a terminal it asks which to publish. Without a terminal, pass `--yes` to publish all of them.

### Where it goes

For each artifact, `publish` uses the first of these that applies:

1. `--to`
2. The registry and namespace an installed artifact came from
3. The default set with `aireg config set defaults.namespace <registry>/<namespace>`, if this scope declares that registry
4. On a terminal, it asks, offering only the registries that accept a publish

The registry must be declared in the project or your user scope. See [`aireg registry add`](registry.md#aireg-registry-add). A path names a registry folder instead, such as `--to ../acme-registry/engineering`, and needs no declaration.

### Versions

A first publish is version `0.1.0`. After that, `publish` takes the next patch version, or the version `--bump` names, counting from the newest published version, even one the registry holds back, such as a blocked one, or a yanked one above `latest`. To publish an exact version, add it to `--to`, such as `--to acme/engineering/pr-review@2.0.0`. A published version is never rewritten, whatever its status, so `publish` refuses a version that is already published, and never sends the work as another version instead. When the registry refuses a version its listing didn't show, the hint names one to pass instead, such as `--to acme/engineering/pr-review@<version>`. After a version that isn't SemVer, such as `1`, there is no next version to work out, so `publish` asks you to name one.

An artifact whose files match the newest published version is listed as `same` and not sent. On a terminal, when an artifact changed and you didn't pass `--bump`, `publish` asks how big a change it is. An export with its own `version` is published at that version, so `publish` never asks about it.

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

Into a registry folder, an agent goes in as `AGENT.md`. A coding agent's own file, such as `.claude/agents/reviewer.md`, goes in as it is, named after the file when its front matter has no `name`, and aireg checks it as `aireg registry validate` would.

## Publishing a repository's exports

A repository that makes skills and agents for others can list them in its manifest, with where they go and what each depends on, so a bare `aireg publish` publishes all of it the same way every time:

```yaml
registries:
  acme: github.com/acme/agent-registry
  public: github.com/acme/public-registry
artifacts:
  - public/platform/skill/sql-style@^1.2
exports:
  - .claude/skills/*
  - path: .claude/agents/reviewer.md
    depends_on:
      - ./.claude/skills/review
      - public/platform/skill/sql-style
  - path: .claude/skills/scratch
    publish: false
publish:
  to: [acme/engineering, ./registry/engineering]
```

The [storage spec](https://github.com/atlanai/ai-registry/blob/main/cli/storage-spec.md) defines each field. With no arguments, `publish` takes every export. In a git repository, only what git tracks counts: a glob such as `.claude/skills/*` reaches only skills with files git tracks, and an export's folder publishes only the files git tracks in it, with its `SKILL.md` always, so a draft or scratch file beside them stays out. A glob never reaches an artifact aireg installed there. An export is a skill folder holding `SKILL.md`, or an agent's `.md` file whose front matter has a `name` and a `description`. A glob skips anything else it matches, such as a `README.md`, and says so, as in `Skipped .claude/skills/README.md, which has no name and description in its front matter, so it is no agent.`; an entry naming one is refused. An export is published from where it really is, so `publish` refuses one that a link, or a glob, takes outside the project, such as a tracked link `.claude/skills/shared` to a folder elsewhere on your machine. Every entry that reaches an artifact applies to it: their `depends_on` lists are combined, and an entry naming the artifact, such as `.claude/skills/review` or `.claude/skills/review/SKILL.md`, sets its `version` and `publish` over a glob that only matches it. Two entries that set one of these differently for the same artifact are refused, naming both. An entry with `publish: false` is left out. A path you name on the command line that is an export follows its entry's rules too; other paths behave as described above.

### Targets

Each export goes to one of the `publish.to` targets. `<registry>/<namespace>` names a declared registry, and a path such as `./registry/engineering` names a namespace in a registry folder, relative to the project. With one target, that is where everything goes. With several, `--to` picks one, and `publish` refuses to guess:

```text
error: The manifest lists 2 publish targets.
  code: usage
hint: Pass `--to acme/engineering` or `--to ./registry/engineering`.
```

A `--to` that the manifest does not list is refused too. An export whose own `publish.to` leaves the target out is listed as `skip`, with the reason, and not sent:

```text
acme  github.com/acme/agent-registry
  add     engineering/skill/review  0.1.0
  skip    engineering/agent/reviewer  its publish.to does not list acme/engineering
```

### Versions

An export with a `version` is published at that version. When the target already holds that version with the same files and dependencies, it is `same`; when it holds it with others, `publish` refuses, since a published version is never rewritten. A version the registry holds back by its status counts as published too: a draft or a version pending review is compared as any other, and `publish` refuses a blocked one, whose files the registry doesn't give, as in `engineering/review@0.2.0 is already published, and is blocked (leaks tokens).` An export without a `version` takes the next one, as any other artifact does.

An export's `version` is never published again with other dependencies, so its dependencies are compared by what they accept: it stays `same` while each edge it was published with still accepts the version this run plans for that dependency. An agent published at `0.0.5` depending on `review ^0.1.0` stays as it is when `review` moves to `0.1.1`. When `review` moves to `0.2.0`, or the agent gains or loses a dependency, `publish` refuses it, and you change its `version`.

A `version` below the target's newest is published as that older version, and the `update` line says so:

```text
  update  engineering/skill/review  0.3.0 → 0.2.5 (below latest)
```

### Dependencies

`publish` writes each `depends_on` entry into the version it publishes as a `depends_on` edge, which [`aireg add`](add.md) and [`aireg install`](install.md) follow to install the dependency too. Exports are published in dependency order, and `publish` refuses exports that depend on each other in a cycle.

- **Another export**, `./<path>`, becomes an edge to the version this run publishes it at, or to the target's newest version when it is unchanged, accepting that version's compatible releases (`^0.3.2`). It must go to the same target, in this run or before it. When it doesn't, `publish` refuses, as in `reviewer depends on review, which is not published to acme/engineering.`
- **An installed artifact**, `<registry>/<namespace>/<kind>/<name>`, must be listed under `artifacts:` by that address, as an entry of its own, and installed, so the lockfile has its version; `publish` refuses one that isn't installed and says to run `aireg install`, and [`aireg remove`](remove.md) refuses to remove it while an export depends on it. The edge names the locked version and accepts what the `artifacts:` entry accepts: its range, only the version it pins, or, with neither, the locked version's compatible releases. When the artifact comes from a registry other than the target, the edge names that registry by its https address, so a project installing the export resolves it in the same registry, when it declares it. That is the address the registry is declared at, or for a folder the https `url` its `registry.json` gives. A registry with neither, such as a folder whose `registry.json` names no `url`, can't be named, and `publish` refuses the dependency.

A project that adds the repository itself, as a folder of skills rather than from a registry, gets these dependencies from the manifest too; see [Sources that are not registries](add.md#sources-that-are-not-registries).

Each `add`, `update` and `same` line shows the dependencies it carries:

```text
acme  github.com/acme/agent-registry
  add     engineering/skill/review  0.1.0
  add     engineering/agent/reviewer  0.1.0, depends on review ^0.1.0, sql-style ^1.2
```

For an artifact without a fixed `version`, a version whose only change is a dependency is a new version. A registry that does not store dependencies with a version is refused before anything is sent; a registry folder stores them.

## Options

| Option | Description |
|---|---|
| `--to <registry>/<namespace>` | Where to publish. Add `/<name>` to publish one artifact under that name, and `/<name>@<version>` to publish it at an exact version. A path, such as `../acme-registry/engineering`, publishes into that registry folder. For exports, one of the manifest's `publish.to` targets; `/<name>` only with one path named. |
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
{"ok": true, "data": {"dryRun": false, "artifacts": [{"name": "triage", "kind": "skill", "registry": "acme", "namespace": "engineering", "from": "1.2.0", "version": "1.2.1", "belowLatest": false, "published": true, "dependsOn": [{"to": "engineering/skill/review@0.3.2", "range": "^0.3.2"}]}], "skipped": [{"name": "reviewer", "kind": "agent", "reason": "its publish.to does not list acme/engineering"}]}}
```

`registry` is the registry's name, or for `--to <folder>` or a folder target, the registry folder as it was written. `from` is `null` for a new artifact, and otherwise the registry's newest version. `belowLatest` is `true` when `version` sorts below `from`, as an export's own `version` can. `published` is `false` for one already published or under `--dry-run`. `dependsOn` lists the edges the version carries, each with its `to`, and its `range` and `registry` when it has them; it is empty for an artifact with none. `skipped` lists the exports whose own `publish.to` leaves the target out.

## Exit status

- `0`: published, nothing new to publish, a dry run, or canceled at a question.
- `1`: the registry isn't declared, a path isn't a skill or an agent or holds a symlink, nothing matches an argument, a skill would fail `aireg registry validate`, or the version is already published, whatever its status. For exports: an entry names nothing, names something that is no skill or agent, or reaches outside the project, two entries set an artifact's `version` or `publish` differently, the exports depend on each other in a cycle, a dependency isn't published to the target, isn't installed or comes from a registry with no https address.
- `2`: the registry doesn't accept published work, as a git registry doesn't, `--to` names no namespace or an invalid name, an artifact has nowhere to go, nothing was named without `--yes` and aireg can't ask, `--changed-since` names a commit that isn't in the repository, or a `--to` path isn't inside a registry folder. For exports: the manifest lists several targets and `--to` names none, `--to` names one it doesn't list, or a registry without dependencies would receive an artifact that has them.
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

Publish this repository's exports to one of its `publish.to` targets, after checking what would go:

```bash
aireg publish --to acme/engineering --dry-run
aireg publish --to acme/engineering --yes
```

Publish only what changed in the last commit:

```bash
aireg publish '.claude/skills/*' --to acme/engineering --changed-since HEAD~1 --yes
```

## See also

[`aireg sync`](sync.md), [`aireg skill`](kinds.md), [`aireg registry`](registry.md), [`aireg status`](status.md), [CLI reference](index.md)
