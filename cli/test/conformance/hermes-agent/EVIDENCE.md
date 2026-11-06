# Hermes Agent evidence

Every path, variable, detection signal, file format and command in `src/targets/hermes-agent.ts` is a claim, and each has a row here. A claim counts only when one of these settles it:

1. the target's official documentation: the exact sentence, its URL and the date it was read;
2. the target's public source, where the documentation is silent: repository, file, line and commit;
3. a real install of the target: the command run, the target version and its output.

A claim no source settles is left out of the definition and recorded as undocumented. The definition, its JSON twin in `test/fixtures/targets/hermes-agent.json` and `hermes-agent.test.ts` match this file exactly.

Every page below was read on 2026-11-06. Hermes Agent's documentation is the Markdown under `website/docs/` in https://github.com/NousResearch/hermes-agent, which https://hermes-agent.nousresearch.com/docs serves; doc and source lines are at tag `v0.23.0`, commit `2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19`. Install rows come from Hermes Agent 0.23.0 run with `HOME` and `HERMES_HOME` in a sandbox folder (`<sandbox>` below) and no sign-in.

## Versions tested

| Program | Version | Released | Installed with |
|---|---|---|---|
| Hermes Agent (`hermes`) | 0.23.0 | tag `v0.23.0` created 2026-11-05 (`git for-each-ref refs/tags/v0.23.0`) | The official git install (`Install method: git`), whose `hermes --version` printed `Hermes Agent v0.23.0 (2026.9.24) · stable · local 2bd378ed1b8d`. Its launcher finds its packages under the home it was installed into (`pm/environments.py:25-38`, `:450-461`), so with a sandbox `HERMES_HOME` it stops with `hermes: no dependency environment is committed for this install; run \`hermes pm repair\``. The rows below run the `hermes` of that install's own dependency environment (`~/.hermes/installs/<key>/environments/<id>/venv/bin/hermes`), which printed `Hermes Agent v0.23.0 (2026.9.24) · upstream ca436069`. Its source matches the checkout file for file: `diff -rq -x __pycache__` over `agent`, `hermes_cli`, `tools` and `pm` reports only `hermes_cli/web_dist`, the built web interface. |

## Claims

| Claim | Source | Quote or output | Version | Result |
|---|---|---|---|---|
| Product name Hermes Agent, program `hermes` | `README.md:19`; `pyproject.toml:6`, `:586-587` | "**The self-improving AI agent built by Nous Research.**" The package is `name = "hermes-agent"`, and `[project.scripts]` gives `hermes = "hermes_cli.main:main"`. | docs, 0.23.0 | confirmed |
| Id `hermes-agent` | `website/docs/reference/environment-variables.md:907`; `hermes_cli/main.py:3210-3222` | "`AI_AGENT` \| **Set to `hermes-agent` by the CLI and gateway entry points** … The value matches Hermes' id in the public agent-harness registry." The source: "the value must be our id in the public agent-harness registry (``hermes-agent``) — matching is exact." | docs, 0.23.0 | confirmed: the id aireg reads from `AI_AGENT` names this target |
| A personal agent | `README.md:19` | "builds a deepening model of who you are across sessions … It's not tied to your laptop — talk to it from Telegram while it works on a cloud VM." | docs | confirmed: `category: "personal-agent"` |
| Project skills from `<root>/.hermes/skills` and `<root>/.agents/skills` | `website/docs/user-guide/features/skills.md:467-476`; `agent/skill_utils.py:517` | "When you launch Hermes inside a git checkout, it looks for skills in: `<project-root>/.hermes/skills/` … `<project-root>/.agents/skills/` # cross-tool convention (shared with other agent CLIs)". `PROJECT_SKILLS_SUBDIRS = (os.path.join(".hermes", "skills"), os.path.join(".agents", "skills"))` | docs, 0.23.0 | confirmed |
| Project root `.agents` | the row above, and the next | A skill in both project folders is never loaded (next row), so a project's skills go in the one folder other tools share. | 0.23.0 | confirmed: its project skill folder is the shared `.agents/skills`, which aireg writes once for every tool that reads it |
| One skill in both project folders loads from neither | `website/docs/user-guide/features/skills.md:502-509`; `agent/skill_utils.py:452-462`; install | "Inside one directory, two *different* skills that share a name are never guessed between." In source, candidates in one tier under different roots resolve to `None`. With byte-identical copies of `lint` in `project/.hermes/skills` and `project/.agents/skills`, `hermes skills list` in the trusted project listed `linked`, `ship` and `ulinked`, and no `lint`. | 0.23.0 | confirmed: aireg never writes `.hermes/skills` in a project |
| The project root is the nearest folder holding `.git`, never the home folder | `website/docs/user-guide/features/skills.md:476`; `agent/skill_utils.py:522-553` | "The project root is the nearest ancestor directory containing `.git` (worktrees and submodules count)." `return None if cur == home else cur` | docs, 0.23.0 | confirmed: a project whose `.agents` is below its repository root is not found (see Left out) |
| Project skills load only once the project is trusted, with `hermes skills trust` | `website/docs/user-guide/features/skills.md:478-494`; `agent/skill_utils.py:597-600`; install | "Hermes does **not** auto-load them from arbitrary cloned repos." and "`hermes skills trust             # trust the current repo`". Output below: untrusted, `pr-review` lists as `local`; trusted, as `project`. | docs, 0.23.0 | confirmed: `trust` for `skill` at `project` |
| User root `~/.hermes` | `website/docs/reference/environment-variables.md:121`; `hermes_constants.py:57-64` | "Defaults to `~/.hermes` on POSIX and `%LOCALAPPDATA%\hermes` on Windows". | docs, 0.23.0 | confirmed on macOS and Linux; Windows is left out |
| `HERMES_HOME` names the user root itself (no `within`) | `website/docs/reference/environment-variables.md:121`; `hermes_constants.py:194-201`, `:1274-1276` | "`HERMES_HOME` \| Select the configuration and user-data home." `get_skills_dir()` returns `get_hermes_home() / "skills"`. | docs, 0.23.0 | confirmed |
| User skills from `$HERMES_HOME/skills` | `website/docs/user-guide/features/skills.md:424`; install | "New agent-created skills are written to `~/.hermes/skills/`". The probe lists `lint` and `ship`, placed there, as `local`. | docs, 0.23.0 | confirmed |
| No user `~/.agents/skills` unless the config lists it | `website/docs/user-guide/features/skills.md:406-420`; install | "If you maintain skills outside of Hermes — for example, a shared `~/.agents/skills/` directory used by multiple AI tools — you can tell Hermes to scan those directories too. Add `external_dirs` under the `skills` section". A skill in `<sandbox>/.agents/skills` was not listed. | docs, 0.23.0 | confirmed: in your user scope a skill lands in `~/.hermes`, never in the shared `~/.agents` |
| Not detected by its project folder | the rows above | `.agents` is the shared folder of several other tools, so finding it proves nothing. | docs | confirmed: `detect.projectRoot: false` |
| Detected by `HERMES_HOME` | `website/docs/reference/environment-variables.md:121` | A variable only Hermes Agent reads. | docs | confirmed |
| Detected by program `hermes` | the first row | No other coding agent installs a program named `hermes`. The name is common, so another tool could share it. | docs | confirmed, with that caveat |
| Caller `HERMES_AGENT` | `website/docs/reference/environment-variables.md:907-908`; `hermes_cli/main.py:3222-3223` | "`HERMES_AGENT` \| **Set to `true` by the CLI and gateway entry points** and exported into every terminal-tool shell so child processes can detect they run inside Hermes specifically." aireg also reads `AI_AGENT` first, which Hermes sets to `hermes-agent`. | docs, 0.23.0 | confirmed |
| A skill is `<skills>/<name>/SKILL.md`, at any depth | `website/docs/user-guide/features/skills.md:335`; `agent/skill_utils.py:882` | `os.walk(str(skills_dir), followlinks=True)` yields every `SKILL.md`, so a category folder (`devops/deploy-k8s`) holds skills too. | docs, 0.23.0 | confirmed |
| A linked skill folder loads | `agent/skill_utils.py:882`; install | `followlinks=True`. A folder linked into `<sandbox>/.hermes/skills` and one linked into `project/.agents/skills` both listed. | 0.23.0 | confirmed, not used: see the next row |
| It rewrites a skill in place as it learns, through a link | `website/docs/user-guide/features/curator.md:281-284`; `tools/skill_manager_tool.py:421`; `utils.py:428-441` | "The background self-improvement review can patch, rewrite, and add support files to any skill it learns from (hand-written, URL-installed, bundled, hub-installed, external, or pinned)". Each write is `atomic_write_text(target, …)`, a temporary file renamed over `target` in its folder, which through a linked folder is aireg's copy. | docs, 0.23.0 | confirmed: skills are written as copies (`place: "copy"`), so an edit shows in `aireg status` instead of changing the stored artifact |
| It edits only skills under your own folders, never a project's | `website/docs/user-guide/features/skills.md:500`; `tools/skill_manager_tool.py:265-300` | "Like external dirs, project skill directories are treated as repo-owned: autonomous skill maintenance (the curator) never modifies them". The editor finds a skill only in `get_all_skills_dirs()`, which leaves out project folders (`agent/skill_utils.py:427-430`). | docs, 0.23.0 | confirmed: a project's shared `.agents/skills` takes copies only because one mapping serves both scopes |
| Same name at two levels: project, then `~/.hermes/skills`, then `create_dir`, then `external_dirs` | `website/docs/user-guide/features/skills.md:496-498` | "Project skills are the **highest-precedence tier**: `project → local (~/.hermes/skills/) → skills.create_dir → external_dirs`." | docs | confirmed |
| Skill front matter: `name`, `description`, `version`, `platforms` and `metadata.hermes` | `website/docs/user-guide/features/skills.md:194-214` | The format's example sets `name`, `description`, `version`, `platforms` and a `metadata.hermes` block of tags, category, toolset conditions and config. | docs | confirmed |
| `disable-model-invocation` keeps the model from running that skill on its own | `website/docs/user-guide/features/skills.md`; source | No page names the key or another one that keeps a skill for a person, and no file under `agent/`, `tools/` or `hermes_cli/` reads `disable-model-invocation`, `disable_model_invocation` or `user-invocable`. | docs, 0.23.0 | undocumented: `keys` sets it to `false`, so a skill that sets it is left out rather than installed without that limit |
| No agents | `website/docs/user-guide/features/delegation.md:105`; `website/docs/user-guide/profiles.md:11` | Subagents come from `delegate_task` at run time: "The subagent receives a focused system prompt built from your goal and context". A profile is "a separate Hermes home directory", not an agent file. No page names an agent definition file. | docs | confirmed: no `agent` mapping, so aireg skips agents for Hermes Agent |
| Plugins are Python it runs | `website/docs/user-guide/features/plugins.md:21-26` | "Drop a directory into `~/.hermes/plugins/` with a `plugin.yaml` and Python code". | docs | confirmed: a plugin lands as its parts (`shape: "contents"`) |
| Reload: the next message names a new skill; `/reload-skills` refreshes slash commands | `website/docs/user-guide/features/skills.md:184-192` | "your next message to the agent carries a short note naming the new skills … `/reload-skills` is not needed for this, it still refreshes the `/skill-name` slash commands." | docs | confirmed |
| Version command `hermes --version` | install | Printed `Hermes Agent v0.23.0 (2026.9.24) · stable · local 2bd378ed1b8d`. | 0.23.0 | confirmed |
| `hermes skills list` lists every skill loaded, with where it came from, and needs no sign-in | install | A table of `Name`, `Category`, `Source` (`local` or `project`), `Trust` and `Status`, from a sandbox with no credentials. | 0.23.0 | confirmed: the L2 probe |

Result is `confirmed`, `wrong` (with what is right) or `undocumented`.

## L2 probes

The target's own commands that list what aireg placed, and what each printed. `hermes-agent.test.ts` runs them after installing the fixtures in the project and in the user scope, with `HERMES_HOME` set to `<sandbox>/.hermes`; Hermes Agent 0.23.0 passed it. Hermes finds a project only at a `.git`, so the probes first run `git init` in the sandbox project. The output below is the same commands run by hand after `aireg add acme/engineering --all --for hermes-agent`, in a project with a `.git` and with `-g`, from `examples/acme-registry`, abridged to the rows that name the skill:

- `hermes skills list`, from the project before it is trusted. Only the user copy loads:
  ```text
  │ pr-review │          │ local  │ local │ enabled │
  ```
- `hermes skills trust`:
  ```text
  Trusted: <sandbox>/home/project
  1 project skill(s) will load in sessions started inside this repo (they take precedence over same-named profile skills).
  ```
- `hermes skills list` again. The project copy loads and shadows the user copy:
  ```text
  │ pr-review │          │ project │ local │ enabled │
  ```
- After `aireg add acme/engineering --all --for hermes-agent,codex`, the project holds one copy, `.agents/skills/pr-review/SKILL.md`, and `hermes skills list` still shows `pr-review` from `project`.

The install printed `warning: "engineering/reviewer" was fetched but installed into no target: Hermes Agent cannot load agents.` After a line was added to `<sandbox>/.hermes/skills/pr-review/SKILL.md`, `aireg status -g` exited 3 with `hint: Hermes Agent reads a copy aireg writes from the skill: run \`aireg install -g --force\` to write it again, and change the skill in its registry.`

## Left out

- **`.hermes/skills` in a project.** Hermes reads it beside `.agents/skills`, and one skill in both loads from neither. aireg writes only `.agents/skills`, the folder Codex, Cursor, OpenCode, Pi and Antigravity also read.
- **A project below its repository root.** Hermes looks for project skills only at the nearest `.git`, so a project aireg was set up in a subfolder of a repository is not seen.
- **Windows.** Hermes's home there is `%LOCALAPPDATA%\hermes`; a built-in user root has one default, under `~/`, so on Windows set `HERMES_HOME`.
- **Profiles.** Each profile is its own home, `~/.hermes/profiles/<name>` (`website/docs/user-guide/profiles.md:11`, `:403`), with its own `skills`. Hermes takes a folder there as a profile only when it holds one of its identity files, while `profiles.root` would make every folder there a target; `HERMES_HOME` points aireg at one profile instead.
- **`skills.external_dirs` and `skills.create_dir`.** Folders a person adds in `config.yaml`; aireg edits no Hermes config.
- **`plugin` as a Hermes plugin.** Its plugins carry Python it runs (`plugins.md:21-26`), which a registry plugin never does.
- **Skill bundles** (`~/.hermes/skill-bundles/`, `skills.md:521-604`), **memory**, **`SOUL.md`** and **MCP**: none is a kind here.

## Secondary sources consulted, not relied on

- https://github.com/vercel-labs/skills/blob/main/docs/agents.md lists Hermes Agent at `.hermes/skills` and `~/.hermes/skills`; the project row is right but loses to `.agents/skills` beside other tools, as above.
