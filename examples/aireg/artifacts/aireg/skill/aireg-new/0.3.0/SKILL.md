---
name: aireg-new
description: Set up a registry of skills and agents for a person or a team, from nothing to installed. Use when asked to create, start or set up a registry, share skills with a team, or turn a folder of existing skills into a registry.
compatibility: Needs the aireg CLI and git, on macOS, Linux or Windows. GitHub steps use gh.
license: Apache-2.0
---

# Set up a registry

A registry is a folder holding `registry.json`, `index.json`, and every artifact under
`artifacts/<namespace>/<kind>/<name>/<version>/`, usually kept in a git repository of its
own or converted from an existing skills repository. Git installs read the requested ref,
or the default branch when none is given. A local folder registry is read as soon as
`aireg registry index` runs. Pass `--json` to the CLI and read `data`.

Use the choices and authorization the user already supplied. Before creating a repository or
pushing, confirm any missing owner, name, visibility or permission. Keep local-only requests
local; prepare handover or CI instructions without installing or configuring them unless asked.

## 1. Agree on three things first

Ask, unless the user already said:

- **Name**: short and lowercase, usually the team or organization. People install with it:
  `<registry>/<namespace>`.
- **Namespaces**: one per team or area, such as `platform` and `data`. One is fine to start.
- **Repository**: reuse the existing skills repository for an in-place conversion. For a new
  repository, agree on its owner, name and visibility. Application repositories can keep
  authoring skills and publish to a separate registry through `aireg-publish`.

For one person, one namespace such as `personal` is enough, and the registry can be a private
repository or a folder on this machine with no remote. The **One person** notes below say
what changes.

Check the CLI with `aireg --version`. If it is missing, ask before running
`curl -fsSL https://aireg.sh/install | sh`, or on Windows
`irm https://aireg.sh/install.ps1 | iex` in PowerShell.

## 2. Create it

For an existing skills-only repository, preserve any uncommitted work and use a conversion
branch. Inspect `registry.json`, `index.json` and the destination `artifacts/` paths first:
`init` overwrites `index.json`. Resolve unrelated existing content with the user before
initializing; if it is already a registry, extend it instead. Run the `init` command below
there; skip `gh repo create`. Keep the import and cleanup together for review so the default
branch does not gain two editable copies. Offer a conversion pull request; create it only
with authorization and do not merge it yourself.

For a new repository, confirm the owner and visibility, then:

```sh
gh repo create <owner>/<repo> --private --clone && cd <repo>   # or --public, as agreed
aireg registry init --name <registry> --description "<one line>" --namespace <namespace> -y
```

`init` writes `registry.json`, `index.json` and `artifacts/<namespace>/`, and nothing else.
If the user already made an empty repository, clone it and run the same `init` inside.

**One person**: for a folder, run `mkdir <folder> && cd <folder> && git init` instead of
`gh repo create`. git keeps the history; aireg does not need it.

## 3. Add the first artifacts

Find what the user already has: `aireg status -g --json` lists the skills and agents in
their own harness folders that aireg does not manage, in `data.unmanaged`, each with its
`kind` and `path`. For a project's, run `aireg status --json` in that project's folder. Bring
them in from the registry's root:

```sh
aireg skill new --from <path> --from <path> --namespace <namespace>   # skills; --from repeats
aireg publish <path> --to ./<namespace> --yes --json                  # an agent's .md file
```

`skill new --from` uses the artifact's declared name; `--name <name>` renames a single import.
For an agent file in a harness folder (the paths `aireg status` lists),
`publish` adds what it lacks, such as `runtime.harness`, and indexes it; any other agent file
needs `runtime.harness` in its front matter. Both copy, leaving the originals where they are.
For an existing repository, also inventory its source folders such as `skills/`; `status`
only discovers harness folders, so it is not a complete list of repository sources.

**Conversion cleanup**: before retiring a source folder, compare the imported files with it
and exercise its bundled scripts, assets and relative references from the imported location.
`skill new --from` omits hidden files and folders; inspect those separately and preserve anything needed before removing a source.
Run `aireg registry index` and `aireg registry validate` before proposing removal.
Find consumers of the old paths, including plugin manifests, install scripts, skill lockfiles
and README links. Show the paths to retire and consumer changes; get agreement before
removing anything unless the user already authorized that cleanup. If compatibility is
unresolved, report the incomplete conversion and keep the working source.

Include removal of the agreed old skill folders and updates to their consumers in the
conversion changes. Leave a README pointer to the registry's install commands and explain
that future edits start with `aireg skill bump <name>` in the namespace, then edit the new
version, index and validate it. Do not remove unrelated repository content or application
sources that will continue publishing through `aireg-publish`.

If the user chose a separate registry to replace an old skills repository, wait until the
registry release is reachable, then offer a cleanup pull request in the old repository with
the same checks and README pointer. Offer archiving only when that whole repository is
retired; confirm the exact repository and get explicit agreement before archiving it.

Or start new ones inside the namespace:

```sh
cd artifacts/<namespace>
aireg skill new <skill>     # or: aireg agent new <agent>
```

`new` writes `TODO` for every field it cannot know. Replace each: the description says what
the skill does and when an agent should use it. Show the user each result before release.

## 4. Prepare the release

```sh
aireg registry index      # validates, then writes artifact.json, versions.json, index.json
aireg registry validate   # exit 0 when the registry is sound
```

Review `git status` and the diff, then stage only registry files and the agreed cleanup.
Leave unrelated local changes unstaged. Commit when requested; do not push or open a pull
request without authorization. A conversion pull request carries the import and cleanup
together; merging it makes the registry available at the repository's default branch.

## 5. Protect it

Add `.github/workflows/registry.yml`. This is the whole CI:

```yaml
name: registry
on: pull_request
permissions:
  contents: read
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0    # brings the target branch, so validate needs no stored credentials
          persist-credentials: false
      - run: curl -fsSL https://aireg.sh/install | AIREG_VERSION=0.1.4 sh
      - run: aireg registry validate
```

Then have the user make the `validate` check required in the repository's branch protection,
so a pull request that breaks the registry cannot merge. aireg never pushes to the registry:
a project that publishes into it does so in a clone, from CI or by hand, and opens a pull
request here, as the aireg-publish skill describes. The same check gates it, and merging it is the
release.

**One person**: the check is optional. Offer it for a repository; skip this step for a folder.

## 6. Hand it over

Prepare handover instructions while a conversion pull request is pending. Bare git addresses
read the remote default branch: wait for the release to merge and become reachable there
before moving active copies or installing. If the user chose an explicit ref, verify that
ref instead. A local folder registry is available after indexing.

Give every teammate these commands, filled in:

```sh
aireg registry add github.com/<owner>/<repo> -g
aireg registry show <registry> --json
# Confirm the expected namespace and artifacts before moving any active copies.
aireg status -g
# Review and back up matching unmanaged copies outside every target harness.
aireg add <registry>/<namespace> -g
aireg status -g
```

**One person**: for a folder, connect its path with `aireg registry add <folder> -g`.
For a private repository, each person needs read access through `gh auth login` or a git
credential helper.

On every machine, check each target harness, such as `~/.claude/skills` and
`~/.agents/skills`: `status` can group several copies into one row with one path. Compare
matching unmanaged copies with the registry and preserve differences. Name every path and
backup destination, and get permission to move them unless already authorized. Move backups
outside all harness search folders; do not publish an old copy to clear a collision.

`add -g` preserves unmanaged folders and can install into only some harnesses. Verify every
intended artifact and harness with `aireg status -g --json`, not just the install exit code.
If installation already skipped a path, back up its blocking copy with permission, run
`aireg install -g --json`, and verify again. Report remaining blocked placements.

`-g` reaches every project and adds a background update job. Explain that before running it
unless the user already approved it. Offer `aireg daemon autostart on` separately when the
user wants updates to start at login.

## Done when

- `aireg registry validate` exits 0, with import, cleanup and consumer changes ready for review.
- Unrelated files and uncommitted work are preserved; any incomplete migration is reported.
- The user has handover instructions, including release readiness and local-copy migration.
- If installation was requested, every intended artifact and harness reports `ok`.
- For a shared registry, the user has the validation workflow and knows to require `validate`,
  or knows that setup is deferred. A local-only request does not require a workflow or push.
