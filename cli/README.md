# aireg

aireg shares skills and agents through registries and installs them into Claude Code, Codex,
Cursor and `.agents` in one step. A registry is a folder or a git repository that holds
`registry.json` and follows the [file spec](../spec/file-spec.md); other stores need an
[adapter](../docs/reference/adapter.md).

```sh
curl -fsSL https://aireg.sh/install | sh
aireg registry add github.com/atlanai/ai-registry --path examples/aireg -g
aireg add ai-registry/aireg -g   # your agents can now set up, install from and publish to registries
```

On Windows, install aireg with `irm https://aireg.sh/install.ps1 | iex` in PowerShell.

Try it on the example registry in this repository, in a scratch project so nothing stays in
your user scope:

```sh
mkdir try-aireg && cd try-aireg && git init
aireg registry add github.com/atlanai/ai-registry --path examples/acme-registry --as example
aireg add example/engineering
```

## Words

- A **registry** is where artifacts are published to and installed from: a folder or a git
  repository holding `registry.json`.
- An **artifact** is a skill, an agent or a plugin.
- aireg installs into **this project**, the default inside a repository, or into **your user
  scope** with `-g`, which reaches every project on the machine.

## Set up a registry

```sh
gh repo create acme/ai-registry --private --clone && cd ai-registry
aireg registry init                             # name, description, namespaces
cd artifacts/engineering
aireg skill new --from ~/.claude/skills/pr-review   # start from a skill you already use
aireg agent new reviewer                        # a new one; fill in its TODOs
cd ../.. && aireg registry index                # validate, then write the index
git add . && git commit -m "release pr-review, reviewer" && git push
```

## Use it

```sh
aireg registry add github.com/acme/ai-registry -g   # named acme, by the registry
aireg add acme/engineering/pr-review@0.1.0                # this project, pinned
aireg add -g acme/engineering                             # your user scope, kept current
aireg install --frozen && aireg status                    # CI
aireg outdated
aireg update
```

## Publish

```sh
aireg skill bump pr-review minor                # in the registry: start 0.2.0
aireg registry index && git add . && git commit -m "release pr-review 0.2.0"
aireg publish .claude/skills/triage --to ../ai-registry/engineering   # into your clone
```

aireg doesn't push to git registries: publish into your clone, then commit and push it with
git.

## Keep your work in sync

```sh
aireg job add -g --registry acme                # take new versions in the background
aireg sync --dry-run                            # what changed here and in the registry
aireg sync resolve pr-review --theirs           # after sync reports a conflict: take the registry's version
```

## Commands

`aireg --help` lists every command, and the [CLI reference](../docs/reference/index.md)
documents each one.

`-g` (`--user`) acts on your user scope instead of the project, `--for claude-code,cursor` picks
the targets, `--json` works everywhere, and nothing prompts in CI or inside an agent. Your
user scope needs no setup: the first `-g` install creates it, and `aireg init -g` is refused.
A released version is never rewritten. How registries, sign-in and pins are stored is in
[storage-spec.md](storage-spec.md).

## Files

```yaml
# .registry/manifest.yml, committed: which targets, registries and artifacts
# (`harnesses:` and these ids keep it readable by aireg 0.1; `targets:` works too)
harnesses:
  - claude
  - codex
registries:
  acme: github.com/acme/ai-registry
artifacts:
  - acme/engineering/skill/pr-review@0.1.0
```

This project and your user scope each keep what they install in one folder. In a project that
is `.registry/`:

```
<repo>/.registry/         this project
├── .gitignore            written by aireg
├── manifest.yml          committed: targets, registries, artifacts
├── manifest.lock.yml     committed: exact versions and digests
├── artifacts/            installed copies, committed by default
├── backups/              your own files aireg moved aside; never committed
└── leases/               which process is writing to the project; never committed
```

Target folders such as `.claude/skills/` link to the copies in `artifacts/`, so a fresh
clone works without running aireg. To stop committing the copies, uncomment `artifacts/` in
`.registry/.gitignore`; `aireg install` then restores them from the lock. aireg never edits
the project's own `.gitignore`.

```
~/.registry/              your user scope, what -g installs (AIREG_USER_SCOPE)
├── manifest.yml
├── manifest.lock.yml
└── artifacts/

~/.aireg/                 the tool (AIREG_HOME)
├── config.yml            accounts, jobs, settings
├── credentials.json      stored sign-in tokens; owner-only (0600)
├── bin/aireg             the command on your PATH
├── cli/<version>/        the installed CLI
├── adapters/             signed adapters
├── state/                background service and run history
├── logs/                 aireg.log, daemon.log, daemon-stderr.log
├── leases/               which process is writing to your user scope
├── journals/             what an interrupted install had done, to finish it
└── cache/                fetched copies of remote registries; safe to delete
```

[Environment and files](../docs/reference/environment.md) describes each of these.

A registry others install from is laid out by the file spec instead: `registry.json`,
`index.json`, an optional `blobs/`, and `artifacts/<namespace>/<kind>/<name>/`, holding
`versions.json` and a `<version>/` folder with `artifact.json` and the artifact's own files.

`AIREG_HOME` moves the tool's folder and `AIREG_USER_SCOPE` moves only your user scope. Other
tool settings are `AIREG_*`, such as `AIREG_LOG_LEVEL` and `AIREG_GIT_TIMEOUT_MS`.
`AIREG_TOKEN_<NAME>` is the token for the registry named `<NAME>`, in capitals with other
characters as `_`, when its adapter signs in; git registries use git's own credentials. It is
sent only to the registry of that name the current scope declares.

## Develop

See [CONTRIBUTING.md](../CONTRIBUTING.md#cli) to run aireg from source, test it and check it as
CI does.
