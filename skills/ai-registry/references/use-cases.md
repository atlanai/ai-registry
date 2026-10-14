# Use cases

What people ask for once aireg and the aireg skills are installed, in order: first one
person's coding agents, then sharing a registry, then a team. Each use
case starts with a prompt a person can paste into a coding agent, then gives the steps for
the agent. The `aireg-new`, `aireg-add` and `aireg-publish` skills have the detail behind each step.

To start from nothing, put `https://github.com/atlanai/ai-registry` on the line before a
prompt. The agent then sets up aireg first, as the setup skill describes.

Ask the user before each step that changes their machine, and before any `git push`.

## Just you

### 1. Your skills, in every coding agent

```text
I've written a few skills for Claude Code. Put them in a private registry in a new GitHub repo called my-skills, and install them so Codex and Cursor can use them too.
```

1. `aireg status -g` lists the skills nothing manages, with their paths. Ask which to bring
   in.
2. Create the registry as the `aireg-new` skill describes, with one namespace:
   `gh repo create <owner>/my-skills --private --clone`, then in it
   `aireg registry init --name my-skills --namespace personal -y`,
   `aireg skill new --from <path> --namespace personal` for each skill,
   `aireg registry index` and a commit.
3. Move the originals out of the harness folders, with the user's yes. aireg doesn't link
   over a folder of theirs.
4. `aireg registry add github.com/<owner>/my-skills -g`, then `aireg add my-skills/personal -g`.
   Claude Code reads `~/.claude/skills`, and Codex and Cursor read `~/.agents/skills`.

Check: `aireg status -g` shows each skill `ok`, and `aireg job list` shows a job for
`my-skills`. If there's no job, `aireg job add -g --registry my-skills` adds one.

### 2. Ship an improvement to every coding agent

```text
Make my commit-message skill use Conventional Commits. Release it as a new version in my registry, then update every coding agent on this machine.
```

1. In an up-to-date clone of the registry:
   `aireg skill bump commit-message minor --namespace personal`, then edit the new
   version's `SKILL.md`.
2. `aireg registry index`, `aireg registry validate` and a commit.
3. `aireg update -g`.

Check: `aireg list -g` shows the new version. The old version stays in the registry.

### 3. Go back to the version that worked

```text
My commit-message skill got worse after my last change. Show me what changed between its last two versions, and put me back on the earlier one.
```

1. The skill's `versions.json` in the registry lists its versions. Read the last two with
   `aireg show my-skills/personal/commit-message@<version>` and show the user what changed.
2. `aireg add my-skills/personal/commit-message@<earlier> -g` pins the earlier version.
3. Tell the user that `aireg add my-skills/personal/commit-message -g` takes the latest again.

## Share it

### 4. Install a registry on another machine

```text
Install everything from my registry at github.com/<owner>/my-skills into every coding agent on this machine, and keep it up to date.
```

This works the same for a teammate's machine or your own second laptop.

1. For a private repository, the person needs read access to it, through `gh auth login` or
   a git credential helper.
2. `aireg registry add github.com/<owner>/my-skills -g`, then `aireg add my-skills/personal -g`.
3. Ask before `aireg daemon autostart on`, which starts the background updates at login.

Check: `aireg list -g` shows the skills, and `aireg job list` shows a job for `my-skills`.

### 5. Check a shared skill before you trust it

```text
A friend shared their registry at github.com/<friend>/skills. Read every skill in it before you install anything, and flag anything that runs commands, downloads files or reads credentials. Then install only the ones I approve, in this project.
```

1. `aireg registry add github.com/<friend>/skills`. This declares the registry and installs
   nothing.
2. `aireg registry show <registry>` lists what it holds. Read each one with
   `aireg show <registry>/<namespace>/<name>`, which installs nothing and warns when an
   artifact carries hooks or MCP servers.
3. Tell the user what each one makes an agent do, and flag the risky ones.
4. Install only the ones the user approves: `aireg add <registry>/<namespace>/<name>`.

## Your team

### 6. A team registry

```text
Set up an agent registry for our platform and data teams in a new private repo, <org>/ai-registry. Bring in the skills from this repo's .claude/skills, add the check that validates every pull request, and give me the commands my team runs to install it.
```

Follow the `aireg-new` skill. It creates the repository and the namespaces, releases the first
skills, adds the validation workflow, and ends with the two commands the team runs.

### 7. Publish from application repositories on merge

```text
This service keeps its skills in .claude/skills. Set up CI so that every merge to main publishes the changed skills to <org>/ai-registry, in the platform namespace, as a pull request there.
```

Follow "Publish a project's skills from CI" in the `aireg-publish` skill. Tell the user how to
create the token secret, and never ask for its value.

### 8. Pin versions and catch drift in CI

```text
Install our pr-review skill from <org>/ai-registry into this repo at its current version, commit what it installs, and add a CI check that fails if anyone edits an installed skill by hand.
```

1. In the project: `aireg add <registry>/<namespace>/pr-review@<version>`, then commit
   `.registry/` and the harness folders it links into, such as `.claude/` and `.agents/`.
2. Add the workflow from "In CI" in the `aireg-add` skill. It runs
   `aireg install --frozen && aireg status`, and `aireg status` exits 3 when an installed copy
   was edited.

### 9. Ship a fix to every project

```text
pr-review 1.2.0 in <org>/ai-registry is flagging false positives in generated code. Release a fix as 1.2.1, withdraw 1.2.0 with a reason, and open a pull request. Then update this project.
```

1. In an up-to-date clone of the registry, on a new branch:
   `aireg skill bump pr-review patch --namespace <namespace>`, then edit 1.2.1.
2. In the skill's `versions.json`, set `"yanked": true` and a `reason` on the 1.2.0 row.
3. `aireg registry index`, `aireg registry validate` and a commit. Ask before you push and
   open the pull request.
4. Once it merges, in each project: `aireg outdated`, then `aireg update`.
