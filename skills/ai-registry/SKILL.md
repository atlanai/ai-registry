---
name: ai-registry
description: Get started with ai-registry, the open specification for agent registries. Installs the aireg CLI and its skills, then helps try the example registry, set up a registry for a person or a team, or install from one. Use when given github.com/atlanai/ai-registry, or asked to set up, install or try ai-registry or aireg.
compatibility: Needs git, on macOS, Linux or Windows. GitHub steps use gh.
license: Apache-2.0
---

# Get started with ai-registry

ai-registry is an open specification for agent registries. A registry is a folder or a git
repository that holds skills and agents, every version of each and their digests, laid out
by the [file spec](https://github.com/atlanai/ai-registry/blob/main/spec/file-spec.md).
aireg is a CLI client for it. It creates registries, publishes to them and installs from
them into Claude Code, Codex and Cursor.

aireg asks no questions when it runs inside a coding agent. Reuse the user's stated choices
and authorization; ask only for missing decisions or actions they have not approved.

## 1. Install aireg

Check with `aireg --version`. If it's missing, show the user the install command and ask
before you run it:

```sh
curl -fsSL https://aireg.sh/install | sh
```

On Windows, run this in PowerShell instead:

```powershell
irm https://aireg.sh/install.ps1 | iex
```

To read the script first, download it with `curl -fsSLO https://aireg.sh/install`, show it
to the user, then run `sh install`; on Windows, download `install.ps1` and run it with
`powershell -ExecutionPolicy Bypass -File install.ps1`. The installer puts aireg in
`~/.aireg/bin` and adds that folder to the PATH of new shells only, so in this session run
`~/.aireg/bin/aireg`.

## 2. Install the aireg skills

The aireg skills cover the rest: `aireg-new` sets up a registry, `aireg-add` installs from one,
and `aireg-publish` publishes to one. Run `aireg doctor`. When the skills are missing, it prints the
command that installs them, pinned to the user's aireg release. Tell the user what the
command does and ask, then run it as printed:

- It installs into the user scope (`-g`), so every project on this machine gets the skills:
  Claude Code reads them from `~/.claude/skills`, and Codex and Cursor from `~/.agents/skills`.
- It adds a background job that keeps the skills current every 15 minutes, and starts
  aireg's daemon to run it. `aireg daemon stop` stops it. `aireg daemon autostart on` would
  start it at every login: ask about that separately.

`aireg job list` then shows the job. Some coding agents load new skills only when a session
starts. Until then, read them where they were installed, such as
`~/.claude/skills/aireg-new/SKILL.md`.

## 3. Try the example registry

Offer this before the user builds their own, unless they already asked for something else.
It installs into a new project, so nothing reaches the user scope:

```sh
mkdir -p ~/try-aireg && cd ~/try-aireg && git init
aireg registry add github.com/atlanai/ai-registry --path examples/acme-registry
aireg add acme/engineering
aireg list
```

`acme/engineering` holds a `pr-review` skill and a `reviewer` agent that depends on it. Show
the user what aireg wrote: `.registry/manifest.yml` records what the project asks for,
`.registry/manifest.lock.yml` the exact version and digest of each, `.registry/artifacts/`
the installed copies, `.claude/skills/`, `.claude/agents/` and `.agents/skills/` the
links each coding agent reads, and `.codex/agents/reviewer.toml` the agent as Codex reads it.

## 4. Ask what the user wants next

If the user's first message already said what they want, do that now. Otherwise ask, and
offer the use cases in [references/use-cases.md](references/use-cases.md) that fit them: 1
to 3 for one person's coding agents, 4 and 5 for sharing a registry, 6 to 9 for a team.
Each one gives its steps.

For anything else, follow the `aireg-new` skill to set up a registry, the `aireg-add` skill
to install from one, or the `aireg-publish` skill to publish to one. For one person, one namespace such as
`personal` is enough, and the pull request check is optional.

For an existing skills-only repository, use `aireg-new`'s in-place conversion path, including
verified cleanup and release readiness. For hand-installed copies on this or another machine,
use `aireg-add`'s migration procedure before installing; check every intended harness afterward.
Keep application sources that will continue publishing to a separate registry.

## Done when

- `aireg --version` works, and `aireg doctor` shows the aireg skills installed.
- The user knows what runs in the background and how to stop it.
- The user has chosen what to do next, or has done it.
