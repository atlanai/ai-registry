# Quickstart

Build your own open agent registry in nine steps. You create a registry, take a test skill through its whole lifecycle, then bring in the skills you already have and let the CLI keep everything in sync.

You need git, with `user.name` and `user.email` set, because each release is a commit. Run the blocks in order, in one terminal. Each one starts in the folder the previous one ended in.

## Install the aireg CLI

To install the aireg CLI, run the following command:

```bash
curl -fsSL https://aireg.sh/install | sh
```

The installer downloads one self-contained binary for macOS or Linux, checks it against a pinned sha256, and installs it under `~/.aireg`. To read the script first, download it with `curl -fsSLO https://aireg.sh/install` and run it with `sh install`. To install a specific release, set `AIREG_VERSION`, as in `curl -fsSL https://aireg.sh/install | AIREG_VERSION=0.1.0 sh`. Check the installation with `aireg --version`.

## Create your first registry

To create your first registry, run:

```bash
mkdir acme-registry && cd acme-registry && git init
aireg registry init --name acme --namespace engineering -y
```

Recall that a registry is a directory of files laid out by the specification, usually kept in a git repository. The above:

1. Creates a directory named `acme-registry` and moves into it.
2. Initializes a git repository.
3. Initializes a registry named `acme` with one namespace, `engineering`.
    1. This writes `registry.json`, an empty `index.json`, and a folder for the namespace under `artifacts/`.

The CLI suggests `cd artifacts/engineering` next. Stay in `acme-registry` instead, since the commands below run from the registry's root.

## Add a test skill

To add a test skill to your registry, run:

```bash
aireg skill new hello-registry --namespace engineering
cat > artifacts/engineering/skill/hello-registry/0.1.0/SKILL.md <<'EOF'
---
name: hello-registry
description: Confirms an aireg install worked. Use when asked to say hello from the registry.
---

When asked to say hello from the registry, reply with exactly "hello from hello-registry 0.1.0" and stop.
EOF
aireg registry index
git add . && git commit -m "release hello-registry 0.1.0"
```

The test skill, `hello-registry`, replies with its own version, so you can watch each version change. The above:

1. Creates `hello-registry` at version 0.1.0 in the `engineering` namespace.
2. Writes the skill's `SKILL.md`.
3. Checks the skill, writes its `artifact.json` with a digest for every file, and generates `versions.json` and `index.json`.
4. Commits the change. The commit is the release.

## Install it into your harnesses

To install the skill into your harnesses, create a project and run:

```bash
cd .. && mkdir my-project && cd my-project && git init
aireg registry add ../acme-registry
aireg add acme/engineering/hello-registry
aireg list
```

The above:

1. Creates a project folder next to the registry and initializes a git repository, which is how the CLI recognizes a project.
2. Connects the registry to the project.
3. Installs the skill. Its full name, `acme/engineering/hello-registry`, names the registry, namespace, and skill.
4. Lists what is installed:

```text
1 installed in this project
  artifact        kind   version  from  harnesses
  hello-registry  skill  0.1.0    acme  Claude Code, Codex
```

The CLI writes the skill's files into the project's `.registry/` folder and links `.claude/skills/` and `.agents/skills/` to them: Claude Code reads the first, Codex the second. It records the registry and the skill in `.registry/manifest.yml` and the exact version and digests in `.registry/manifest.lock.yml`; commit `.registry/`, `.claude/` and `.agents/` so teammates get the same skill. Open Claude Code or Codex in `my-project` and ask it to say hello from the registry: it answers with 0.1.0.

!!! warning
    Run installs inside a git repository. Outside one, the CLI installs into your user scope instead, for every project on your machine, and starts its background sync.

## Release an update

To release an update, create a new version of the skill in the registry, then take it in the project:

```bash
cd ../acme-registry
aireg skill bump hello-registry minor --namespace engineering
cat > artifacts/engineering/skill/hello-registry/0.2.0/SKILL.md <<'EOF'
---
name: hello-registry
description: Confirms an aireg install worked. Use when asked to say hello from the registry.
---

When asked to say hello from the registry, reply with exactly "hello from hello-registry 0.2.0" and stop.
EOF
aireg registry index
git add . && git commit -m "release hello-registry 0.2.0"

cd ../my-project
aireg outdated
aireg update
```

The above:

1. Copies 0.1.0 into a new 0.2.0 folder, so 0.1.0 never changes and anything pinned to it keeps working.
2. Writes the new version's `SKILL.md`, which replies with 0.2.0.
3. Indexes and commits the release.
4. In the project, shows the newer version and takes it:

```text
1 with a newer version in this project
  artifact        from  current  latest
  hello-registry  acme  0.1.0    0.2.0

  next   aireg update
```

After `aireg update`, ask your agent again: it answers with 0.2.0.

## Uninstall the skill

To uninstall the skill from your harnesses, run:

```bash
aireg remove hello-registry
aireg list
```

This unlinks the skill from every harness in the project. Both versions stay in the registry. In a terminal, `aireg remove` lists what it will remove and asks you to confirm.

## Add the skills you already have

To bring the skills your harnesses already have into the registry, first list the ones the CLI does not manage:

```bash
aireg status -g
```

```text
Nothing is installed in your user scope.

2 unmanaged
  artifact   kind   harness      path
  lint       skill  Claude Code  ~/.claude/skills/lint
  pr-review  skill  Claude Code  ~/.claude/skills/pr-review
  next   aireg publish <path> --to <registry>/<namespace>
```

`-g` looks at your user scope: the harness folders in your home folder, such as `~/.claude/skills`. Without it, `aireg status` checks the project's own harness folders. If you accepted the installer's offer of the aireg skills, `add`, `new` and `publish` are also listed, as installed from `ai-registry`.

Then bring each one in, release them, and install them into the project. Replace `pr-review` and `lint` with the names `aireg status -g` lists:

```bash
cd ../acme-registry
aireg skill new --from ~/.claude/skills/pr-review ~/.claude/skills/lint --namespace engineering
aireg registry index
git add . && git commit -m "release pr-review 0.1.0, lint 0.1.0"

cd ../my-project
aireg add acme/engineering -s pr-review -s lint
```

The above:

1. Copies each skill folder into the `engineering` namespace as version 0.1.0 of a new skill. The originals stay where they are.
2. Indexes and commits the release.
3. Installs the two skills into the project. `-s` picks skills from the namespace; without it, `aireg add acme/engineering` installs every skill in it, `hello-registry` included.

## Keep it in sync automatically

To keep a folder of skills in sync with the registry automatically, connect the registry to your user scope and add a sync job:

```bash
aireg registry add ../acme-registry -g
aireg job add -g --watch ~/.claude/skills --to acme/engineering
```

The daemon is a background process that runs sync jobs every 15 minutes. `aireg job add` starts it and runs the new job once straight away. The above:

1. Connects the registry to your user scope. `-g` on both commands makes the job keep your user scope in sync, whichever project you are in; without it, the job belongs to the current project.
2. Adds a job that watches `~/.claude/skills` and publishes the skills in it to the `engineering` namespace. A skill the registry doesn't have yet is published as a new skill at 0.1.0, and each later edit becomes its next version, so keep skills you don't want to share out of that folder.

Edit a skill in `~/.claude/skills`, then run the job now instead of waiting:

```bash
aireg job start job_skills_acme
```

The edited skill becomes its next patch version, for example `pr-review` 0.1.1, in the registry folder. aireg doesn't commit or push to registries in git repositories, so check the change with `git status` in `acme-registry` and commit it as before.

To see what is running, and to stop it:

```bash
aireg daemon status
aireg job list
aireg job runs
aireg job remove job_skills_acme
aireg daemon stop
```

`aireg daemon status` shows whether the daemon is running, how many jobs it has, and whether autostart is on. `aireg job list` shows each job, its registry and its state, and `aireg job runs` shows recent runs and what they changed. `aireg job remove` stops syncing that folder, and `aireg daemon stop` stops the daemon. `aireg daemon status` prints:

```text
Running   version X.Y.Z, pid 14300
Jobs      1 of 1 enabled
Autostart off
```

If you installed the aireg skills, `Jobs` counts their job too. Autostart is off until you run `aireg daemon autostart on`, which starts the daemon at login. `aireg console` shows installed artifacts, jobs and registries in one view.

## Let your coding agent do it

The ai-registry repository also comes packaged with agent skills to help you manage registries using your preferred harness: `new`, `add`, and `publish`.

These skills respectively set up a registry of skills and agents for a person or a team, from nothing to installed; find, install, and update skills and agents from a registry, in a project or in your user scope; and publish a skill or agent to a registry, or release a new version of one.

To give your coding agent the registry skills, run:

```bash
aireg registry add github.com/atlanai/ai-registry --path examples/aireg -g
aireg add ai-registry/aireg -g
```

This connects the registry that holds the skills and installs them into your user scope for Claude Code and Codex, so they're available in every project. It also adds a job that keeps them up to date, so the daemon starts again. In Claude Code they appear as `/aireg:new`, `/aireg:add`, and `/aireg:publish` in a new session. When the installer runs in a terminal, it offers to install them for you, from the release that matches your aireg; without a terminal it leaves them out. `aireg doctor` tells you whether they are installed, and prints the command, pinned to that release, when they are not.

Once installed, you can use your preferred harness to manage registries. For example, "set up a registry for my team's skills" or "publish the skills in `~/.claude/skills` to the acme registry".

## Where to go next

<div class="grid cards" markdown>

-   **Use cases**

    ---

    Explore several use cases you can run with a registry, using the aireg CLI.

    [:octicons-arrow-right-24: Use cases](use-cases/teams.md)

-   **Example: acme-registry**

    ---

    Walk through what happens within the registry during core tasks.

    [:octicons-arrow-right-24: Example](example.md)

</div>
