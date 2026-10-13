---
name: aireg-new
description: Set up a registry of skills and agents for a person or a team, from nothing to installed. Use when asked to create, start or set up a registry, share skills with a team, or turn a folder of existing skills into a registry.
compatibility: Needs the aireg CLI and git, on macOS or Linux. GitHub steps use gh.
license: Apache-2.0
---

# Set up a registry

A registry is a folder holding `registry.json`, `index.json`, and every artifact under
`artifacts/<namespace>/<kind>/<name>/<version>/`, kept in a git repository of its own.
Releasing is a commit. Pass `--json` to the CLI and read `data`.

## 1. Agree on three things first

Ask, unless the user already said:

- **Name**: short and lowercase, usually the team or organization. People install with it:
  `<registry>/<namespace>`.
- **Namespaces**: one per team or area, such as `platform` and `data`. One is fine to start.
- **Repository**: which owner, and private or public. Give the registry a repository of its
  own: releases, reviews and the validation check then cover the registry and nothing else.

Check the CLI with `aireg --version`. If it is missing, ask before running
`curl -fsSL https://aireg.sh/install | sh`.

## 2. Create it

Confirm the owner and visibility, then:

```sh
gh repo create <owner>/<repo> --private --clone && cd <repo>   # or --public, as agreed
aireg registry init --name <registry> --description "<one line>" --namespace <namespace> -y
```

`init` writes `registry.json`, `index.json` and `artifacts/<namespace>/`, and nothing else.
If the user already made an empty repository, clone it and run the same `init` inside.

## 3. Add the first artifacts

Find what the user already has: `aireg status -g --json` lists the skills and agents in
their own harness folders that aireg does not manage, in `data.unmanaged`, each with its
`kind` and `path`. For a project's, run `aireg status --json` in that project's folder. Bring
them in from the registry's root:

```sh
aireg skill new --from <path> --from <path> --namespace <namespace>   # skills; --from repeats
aireg publish <path> --to ./<namespace> --yes --json                  # an agent's .md file
```

`skill new --from` takes the folder's name; for one that isn't a valid name, bring it in alone
with `--name <name>`. For an agent file in a harness folder (the paths `aireg status` lists),
`publish` adds what it lacks, such as `runtime.harness`, and indexes it; any other agent file
needs `runtime.harness` in its front matter. Both copy, leaving the originals where they are.

Or start new ones inside the namespace:

```sh
cd artifacts/<namespace>
aireg skill new <skill>     # or: aireg agent new <agent>
```

`new` writes `TODO` for every field it cannot know. Replace each: the description says what
the skill does and when an agent should use it. Show the user each result before release.

## 4. Release it

```sh
aireg registry index      # validates, then writes artifact.json, versions.json, index.json
aireg registry validate   # exit 0 when the registry is sound
git add . && git commit -m "release <what>"
```

Ask before `git push`.

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
      - run: curl -fsSL https://aireg.sh/install | AIREG_VERSION=0.1.0 sh
      - run: aireg registry validate
```

Then have the user make the `validate` check required in the repository's branch protection,
so a pull request that breaks the registry cannot merge. aireg never pushes to the registry:
a project that publishes into it does so in a clone, from CI or by hand, and opens a pull
request here, as the aireg-publish skill describes. The same check gates it, and merging it is the
release.

## 6. Hand it over

Give the user what the team runs, filled in:

```sh
aireg registry add github.com/<owner>/<repo> -g
aireg add <registry>/<namespace> -g
```

`-g` installs into the user scope, so every project on the machine gets the registry's
skills, and the background service keeps them current; `aireg daemon autostart on` starts it
at each login. Offer to run these here. For a private repository, each person needs read
access to it, through `gh auth login` or a git credential helper.

Once `aireg status -g --json` shows the installed copies as `ok`, the originals brought in
at step 3 still sit in the harness folders, so each skill appears twice. Offer to remove the
originals, naming each path, and remove nothing without the user's yes.

## Done when

- `aireg registry validate` exits 0 and the release is committed.
- The validation workflow is in place and the user knows to make `validate` required.
- The team's two install commands are in the user's hands, with the real names in them.
