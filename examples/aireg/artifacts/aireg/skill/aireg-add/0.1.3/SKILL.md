---
name: aireg-add
description: Connect a registry and install, inspect, update or remove its skills and agents in a project or user scope. Use when managing registry installs, checking versions or provenance, or diagnosing missing, edited or blocked copies in coding agents.
compatibility: Needs the aireg CLI and git, on macOS, Linux or Windows.
license: Apache-2.0
---

# Install from a registry

An artifact's full name is `<registry>/<namespace>/<name>`, optionally `@<version>`. Add the
kind, as in `<registry>/<namespace>/skill/<name>`, only when a skill and an agent share the name.
Pass `--json` to every command and read `data`; nothing prompts under `--json`. Reuse the
user's stated scope, harness choices and authorization; ask only for missing decisions or
actions they have not approved.

## Answer from aireg, not from the folders

`.claude/skills` and `.agents/skills` hold the user's own skills beside links to installed
copies, and `.registry/` holds aireg's own files. Listing or reading them can't tell an
installed copy from the user's own, an edited one or one that's behind, so answer with aireg:

| Ask | Command |
| --- | --- |
| What is installed | `aireg list --json` |
| Where one came from, and its version | `aireg list <name> --json`: `data.registry`, `data.address`, `data.version` |
| Edited, missing in a harness, or why one isn't loading | `aireg status --json`: each of `data.artifacts` has its `state` and `harnesses`; `data.unmanaged` lists the skills in the harness folders that aireg doesn't manage |
| Behind its registry | `aireg outdated --json` |
| What an update would change | `aireg outdated --json`, then `aireg show <registry>/<namespace>/<name>@<version> --json` for the newer version |
| Remove one | `aireg remove <name> --dry-run --json`, show the user `data.removed`, then run it without `--dry-run`, with `--yes` |

Add `-g` to each for the user's own installs.

After an install or update, run `aireg status --json` and verify every intended artifact
and harness. Use `aireg list --json` for version and provenance details.
Don't take the exit code as success: `add` can exit 0 when a skill reached no harness.

## 1. Check the CLI

Run `aireg --version`. If it is missing, ask before running
`curl -fsSL https://aireg.sh/install | sh`, or on Windows
`irm https://aireg.sh/install.ps1 | iex` in PowerShell.

## 2. Connect the registry, once

Skip this when `aireg registry list --json` already lists it.

```sh
aireg registry add <address> --json
```

`<address>` is what the user gave, always with its host: `github.com/<owner>/<repo>`, a link
copied from the browser, or a local folder. A bare `<owner>/<repo>` is refused. The registry
names itself; use `data.registry` from here on. Pass `--as <name>` only when the user asks, or
the command says the name is taken. Add `-g` when the install below is for the user.

## 3. Find and read

```sh
aireg registry show <registry> --json                 # data.entries: name, kind, namespace, version, description
aireg show <registry>/<namespace>/<name> --json       # data.body; nothing is installed
```

Build every full name from `aireg registry show`; never guess one. Read a skill with `show` before
installing it when the user has not seen it.

## 4. Install

Before replacing hand-installed skills with registry versions, run `aireg status --json`
(with `-g` for the user scope). Review matching unmanaged copies in every target harness:
`data.unmanaged` can group several copies into a row with only one path. Offer to move each
blocking copy to a backup outside harness search folders, showing the paths and destinations.
Get agreement unless that backup was already authorized. Preserve differing copies for review; do not publish
them just to clear an install collision. Unrelated unmanaged skills stay where they are.

| Where | Command |
| --- | --- |
| This project, one artifact | `aireg add <registry>/<namespace>/<name> --yes --json` |
| This project, held at one version | `aireg add <registry>/<namespace>/<name>@<version> --yes --json` |
| This project, a whole namespace | `aireg add <registry>/<namespace> --yes --json` |
| The user, in every project | `aireg add <registry>/<namespace>/<name> -g --yes --json` |

Inside a repository, installs belong to the project. aireg keeps them in `.registry/`:
`manifest.yml` records what the project asks for, `manifest.lock.yml` the exact versions and
digests, and `artifacts/` the installed copies. Commit the folder; teammates run
`aireg install`. Explain `-g` before running it unless already authorized: it installs into
the user scope, reaches every project here, and adds a background update job. Outside a repository, `add` installs into the
user scope even without `-g`, so check where you are first.

Pin with `@<version>` only when the user asks: `update` never moves a pin. Adding the
artifact again at another version moves the pin, and adding it without one removes the pin.
`add` also installs the versions an artifact's dependencies name.

`add` refuses more than 10 artifacts at once, with exit 2, even with `--yes`. Pick them with
`-s <name>`, repeated, or pass `--all` once the user agrees to take them all.

`--for claude,cursor` picks the harnesses to install into; without it, the manifest's
`harnesses:` list decides, or Claude Code and Codex when it has none.

## 5. Keep it current

```sh
aireg outdated --json      # exit 3: something unpinned is behind, or a registry couldn't be checked
aireg update --yes --json
aireg status --json        # exit 3: an installed copy is missing or was edited
aireg list --json
```

Add `-g` to each for the user's own installs. `aireg status` also lists, in
`data.unmanaged`, skills in the harness folders that aireg does not manage.

To keep this project current in the background, ask, then run
`aireg job add --registry <registry> --json` here. A `-g` install gets a job of its own.

## In CI

Check every pull request against the lockfile, so nobody changes an installed skill by hand
and every install matches what was reviewed. Add `.github/workflows/skills.yml`, filled in
here for a registry named `acme`:

```yaml
name: skills
on: pull_request
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - run: curl -fsSL https://aireg.sh/install | AIREG_VERSION=0.1.4 sh
      - run: aireg install --frozen && aireg status
```

The check reads the installed copies the project committed in `.registry/`, so it needs no
access to the registry, even a private one, and no secret.

## When something fails

| Exit | Meaning | Do |
| --- | --- | --- |
| 0 | A warning says a destination already holds something of yours | Show every blocked path; with permission, move the copies to backups outside harness search folders, then run `aireg install --json` (with `-g` for the user scope) and verify every intended harness with `aireg status --json` |
| 1 | The command failed: no such name or version, or dependencies that disagree | Follow the `hint`, or report the `error` |
| 2 | The command was incomplete, or names more than 10 artifacts | Supply what the `hint` names |
| 3 | From `install --frozen` or `status`: the lockfile or the manifest would change, or an installed copy changed | Run `aireg install` locally and commit, or undo the edit |
| 3 | From `outdated`: a newer version exists, or a registry couldn't be checked | Offer `aireg update`; for one it couldn't check, report why |
| 4 | The registry refused access | Ask the user to sign in as the `hint` says: for a git registry, `gh auth login` or a git credential helper |

With `--json`, a failure is `error` with its `code`, `message` and `hint`. Report the message and hint as they are; do not retry with other flags.
