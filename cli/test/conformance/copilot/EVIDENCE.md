# GitHub Copilot evidence

Every path, variable, detection signal, file format and command in `src/targets/copilot.ts` is a claim, and each has a row here. A claim counts only when one of these settles it:

1. the target's official documentation: the exact sentence, its URL and the date it was read;
2. the target's public source, where the documentation is silent: repository, file, line and commit;
3. a real install of the target: the command run, the target version and its output.

A claim no source settles is left out of the definition and recorded as undocumented. The definition, its JSON twin in `test/fixtures/targets/copilot.json` and `copilot.test.ts` match this file exactly.

Every page below was read on 2026-10-19. Every command ran in a sandbox with `HOME` (and `COPILOT_HOME` where a row says so) inside it, `COPILOT_AUTO_UPDATE=false`, no account and no credentials. The definition follows Copilot CLI, the one Copilot program that installs on its own; Copilot in VS Code reads the same folders, as its rows say.

Pages, all under `https://docs.github.com/en/copilot/`:

- **skills**: `how-tos/copilot-cli/customize-copilot/add-skills`
- **agents**: `how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli`
- **reference**: `reference/copilot-cli-reference/cli-command-reference`
- **config dir**: `reference/copilot-cli-reference/cli-config-dir-reference`
- **plugins**: `reference/copilot-cli-reference/cli-plugin-reference`
- **configure**: `how-tos/copilot-cli/set-up-copilot-cli/configure-copilot-cli`
- **install**: `how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli`

## Versions tested

| Program | Version | Released | Installed with |
|---|---|---|---|
| `@github/copilot` | 1.0.96 | 2026-10-12 (npm `time`: `2026-10-12T18:51:30.474Z`) | `npm install --prefix <prefix> --ignore-scripts @github/copilot@1.0.96`, which also installs `@github/copilot-linux-x64@1.0.96`; the package declares no install scripts |

`copilot --version` prints `GitHub Copilot CLI 1.0.96.`

## Claims

| Claim | Source | Quote or output | Version | Result |
|---|---|---|---|---|
| Project root `.github` | skills; agents | "For **project skills**, specific to a single repository, create a `.github/skills`, `.claude/skills`, or `.agents/skills` directory in your repository."; "**Project** (`.github/agents/`)" | 1.0.96 | confirmed |
| User root `~/.copilot` | config dir; skills; agents | "By default, this directory is `~/.copilot` (that is, `$HOME/.copilot`)."; "For **personal skills**, shared across projects, create a `~/.copilot/skills` or `~/.agents/skills` directory in your local home directory."; "**User** (`~/.copilot/agents/`)" | 1.0.96 | confirmed |
| `COPILOT_HOME` names the user root itself | config dir, "Changing the location of the configuration directory" | "`COPILOT_HOME` replaces the entire `~/.copilot` path. The value you set should be the complete path to the directory you want to use for the configuration files and subdirectories." | 1.0.96 | confirmed |
| The same, by install | `copilot skill list --json` and a prompt-mode session (see L2 probes) with a skill and an agent in `<sandbox>/alt/` and others in `<sandbox>/.copilot/` | With `COPILOT_HOME=<sandbox>/alt`: `alt-skill personal-copilot <sandbox>/alt/skills/alt-skill` and the agent `alt-agent`; nothing from `<sandbox>/.copilot/` | 1.0.96 | confirmed |
| Detected by `COPILOT_HOME` being set | `copilot help environment` | "`COPILOT_HOME`: override the directory where configuration and state files are stored; defaults to `$HOME/.copilot`." | 1.0.96 | confirmed |
| Detected by the program `copilot` | install; the npm package's `package.json` | "npm install -g @github/copilot"; `"bin": { "copilot": "npm-loader.js" }` | 1.0.96 | confirmed |
| Not detected by a project's `.github` folder (`detect.projectRoot: false`) | https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax (read 2026-10-20); skills; agents | "You must store workflow files in the `.github/workflows` directory of your repository." So `.github` holds the workflows of most GitHub repositories, whether or not anyone there uses Copilot, as well as Copilot's project skills and agents | 1.0.96 | confirmed: the folder alone proves nothing |
| Detected by the program `code` | install; the program is VS Code's own | No page says `code` on `PATH` means Copilot is installed; VS Code installs it whether or not Copilot is used | 1.0.96 | undocumented: left out |
| Caller variable `COPILOT_CLI` | github/copilot-cli:changelog.md:2502@84a2bd392a397e3dafaa9a1212b2964c3bd694bc (0.0.421); a prompt-mode session that ran `env` through its shell tool | "Git hooks can detect Copilot CLI subprocesses via the COPILOT_CLI=1 environment variable to skip interactive prompts"; the command saw `COPILOT_CLI=1` | 1.0.96 | confirmed |
| Caller variable `VSCODE_AGENT` | microsoft/vscode:src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/toolTerminalCreator.ts:158-159@c2f7817f9132a822cef2078e1f5fda05b74d785c | An agent's terminal gets `[AiAgentEnvVar]: AiAgentEnvValue, COPILOT_AGENT: '1'`, that is `AI_AGENT=github_copilot_vscode_agent`; the source sets no `VSCODE_AGENT` | n/a | wrong: aireg already reads `AI_AGENT` first, so no variable is added for Copilot in VS Code |
| Caller variables `COPILOT_MODEL`, `COPILOT_ALLOW_ALL` | `copilot help environment`; the same session | "`COPILOT_MODEL`: optionally set the agent model."; "`COPILOT_ALLOW_ALL`: allow all tools to run automatically without confirmation." Both are settings a person exports; the session's command saw `COPILOT_ALLOW_ALL` unset and `COPILOT_MODEL` only because the run set it | 1.0.96 | wrong: removed from the caller signals |
| Reads skills from `.github/skills`, `.agents/skills` and `.claude/skills` in a project | reference, "Skill locations"; `copilot skill list --json` | "Skills are loaded from these locations in priority order (first found wins for duplicate names)." Rows `.github/skills/`, `.agents/skills/`, `.claude/skills/` (Project), `~/.copilot/skills/` and `~/.agents/skills/` (Personal). Install lists one skill from each project folder with `"source": "project"` | 1.0.96 | confirmed |
| Reads `~/.agents/skills` only while `COPILOT_HOME` is unset | install, as in the `COPILOT_HOME` row | Without the variable: `user-agents-skill personal-agents <sandbox>/.agents/skills/user-agents-skill`. With it, that skill is gone | 1.0.96 | confirmed; so no `reads`, see Left out |
| Reads `.claude/agents` in a project, not `~/.claude/agents` | reference, "Custom agent locations"; the session | Rows `~/.copilot/agents/` (User), `.github/agents/` and `.claude/agents/` (Project). The session offers `claude-proj` from `.claude/agents/` and not `claude-user` from `~/.claude/agents/` | 1.0.96 | confirmed; so no `reads`, see Left out |
| Skill at `skills/<name>/SKILL.md` | skills | "Within the `skills` directory, create a subdirectory for your new skill."; "Skill files must be named `SKILL.md`." | 1.0.96 | confirmed |
| A skill folder may be a link | install: `.github/skills/linked-skill` and `~/.copilot/skills/user-linked-skill` as links to folders elsewhere | `copilot skill list --json`: `linked-skill project .../.github/skills/linked-skill`, `user-linked-skill personal-copilot .../.copilot/skills/user-linked-skill` | 1.0.96 | confirmed |
| A skill in two folders it reads loads once | install: the same linked folder in `.github/skills/` and `.agents/skills/` | `copilot skill list --json` lists `linked-skill` once, from `.github/skills` | 1.0.96 | confirmed |
| Agent at `agents/<name>.agent.md` | agents; config dir | "Each custom agent is defined by a Markdown file with an `.agent.md` extension."; "Store personal custom agent definitions here as `.agent.md` files." | 1.0.96 | confirmed |
| The file name is the agent's id; `name` is optional | reference, "Custom agents reference" and "Custom agent frontmatter fields" | "The CLI removes the `.agent.md` or `.md` extension and replaces directory separators with `--`."; "`name` \| string \| No \| Display name." | 1.0.96 | confirmed |
| An agent file may be a link | install: `.github/agents/linked-agent.agent.md` and `~/.copilot/agents/user-linked-agent.agent.md` as links | The session offers `linked-agent` and `user-linked-agent` | 1.0.96 | confirmed |
| Unknown front-matter keys do not stop an agent loading, so no codec | install: an agent with `color: blue`, `madeup-key: 3` and `tools: Read, Grep` | The session offers `odd-agent`; run as a subagent, it gets the tools `view` and `grep` only, so its `tools` still limits it | 1.0.96 | confirmed |
| Plugin as a native plugin | plugins, "File locations"; config dir, `config.json`; install | "`~/.copilot/installed-plugins/MARKETPLACE/PLUGIN-NAME` (installed via a marketplace) and `~/.copilot/installed-plugins/_direct/SOURCE-ID/` (installed directly)"; `config.json` "only holds internal state such as installed plugins and trusted folders". A folder with a `plugin.json` placed under `installed-plugins/_direct/` by hand is not in `copilot plugin list --json`. The other way, `enabledPlugins` in `settings.json`, is a file "with comments (JSONC)" | 1.0.96 | confirmed: no native plugin, `shape: "contents"` |
| A plugin's command is a skill only a person invokes | CLI reference, skill front matter; `aireg add <plugin folder> --all --for copilot`, the plugin holding `commands/deploy.md`, then `copilot skill list --json` from the project and from the home folder | "`disable-model-invocation` \| boolean \| No \| Prevent the agent from automatically invoking this skill." Output: `toolkit-deploy project <sandbox>/project/.github/skills/toolkit-deploy` and `toolkit-deploy personal-copilot <sandbox>/home/.copilot/skills/toolkit-deploy` | 1.0.96 | confirmed |
| Folder trust has no command | configure, "Setting trusted directories" | "When you start a GitHub Copilot CLI session, you'll be asked to confirm that you trust the files in, and below, the directory from which you launched the CLI."; "Trusted directories are stored in the automatically managed `config.json` file." | 1.0.96 | confirmed: no `trust` entry |
| Skills and agents placed in a project list without trust | install | `copilot skill list --json` lists project skills, and a prompt-mode session offers project agents, in a folder whose `config.json` holds no `trustedFolders` | 1.0.96 | confirmed |
| `reload`: `/skills reload`, and a new session for agents | skills; agents; reference, slash commands | "if you have added a skill during a CLI session, you can add it using the command `/skills reload` to avoid having to restart the CLI to use it."; "Restart the CLI to load your new custom agent." | 1.0.96 | confirmed |
| `verified.command`: `copilot --version` | install | `GitHub Copilot CLI 1.0.96.` | 1.0.96 | confirmed |
| `COPILOT_AUTO_UPDATE=false` keeps the tested version | `copilot help environment`; install | "`COPILOT_AUTO_UPDATE`: set to \"false\" to disable downloading updated CLI versions automatically." Without it, a session downloaded a newer version into the package cache, and the next launch ran that version | 1.0.96 | confirmed: set in the test's `env` |
| Copilot in VS Code reads the same folders | microsoft/vscode-docs:docs/agent-customization/agent-skills.md:69-70 and custom-agents.md:123-125@c391542bd563ee3a7fdf9591785b76e0dc5bf3b1 | "Project skills, stored in your repository \| `.github/skills/`, `.claude/skills/`, `.agents/skills/`"; "Workspace \| `.github/agents` folder \| `.agent.md` or `.md` files"; "`~/.copilot/agents` folder \| `.agent.md` or `.md` files" | n/a | confirmed, not installed |

Result is `confirmed`, `wrong` (with what is right) or `undocumented`.

## L2 probes

The target's own commands that list what aireg placed, and what each printed. `copilot.test.ts` runs both after installing the fixtures in the project and in the user scope, with `COPILOT_HOME=<sandbox>/.copilot`. Neither needs an account (reference, "Managing skills non-interactively": "`list [--json]` \| List all discovered skills.").

- `copilot skill list --json`, from the project:
  ```json
  {
    "name": "lint",
    "description": "Lints a change.",
    "source": "project",
    "path": "<sandbox>/project/.github/skills/lint",
    "enabled": true
  }
  ```
  `lint` from the user scope is not listed, because a project skill of the same name wins.
- `copilot skill list --json`, from the home folder: `lint` and `ship`, each `"source": "personal-copilot"` at `<sandbox>/.copilot/skills/<name>`.
- `copilot plugin list --json` lists only the plugin built into the CLI, as expected: a plugin lands as its parts.

Copilot CLI has no command that lists agents outside a session (`/agent` and `/env` run inside one), and a session needs a model. The agent rows above come from a prompt-mode session against a local endpoint that only records the requests it gets: `COPILOT_OFFLINE=true COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:<port>/v1 COPILOT_MODEL=fake copilot -p probe --allow-tool shell` (`copilot help environment`, `COPILOT_PROVIDER_BASE_URL`: "When set, the CLI uses this provider instead of GitHub Copilot's model routing. GitHub authentication is not required."). The custom agents are the `agent_type` values the session's `task` tool offers, for example `['explore', 'task', 'general-purpose', 'code-review', 'research', 'security-review', 'planner', 'reviewer']` after the fixtures are installed. This takes a server of its own, so it is not one of the test's probes.

## Left out

- **`reads`.** Copilot CLI also reads `.agents/skills`, `.claude/skills` and `.claude/agents` in a project, and `~/.agents/skills` in your user scope, but `reads` names a folder for every scope: it would let aireg place user skills in `~/.agents/skills`, which Copilot skips once `COPILOT_HOME` is set, and user agents in `~/.claude/agents`, which it never reads. aireg places into Copilot's own folders, which it reads at every scope; a skill another target also gets in a shared folder loads once.
- **A native plugin.** Copilot loads one only after `copilot plugin install` records it in `config.json`, or through `enabledPlugins` in the JSONC `settings.json`; aireg edits neither. A plugin lands as its skills and agents.
- **`trust`.** The folder trust prompt has no command, and aireg never writes `trustedFolders`. The docs page names the prompt.
- **`code`** as a detection signal, **`VSCODE_AGENT`**, **`COPILOT_MODEL`** and **`COPILOT_ALLOW_ALL`** as caller variables, as the claims say.
