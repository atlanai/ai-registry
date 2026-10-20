# Claude Code evidence

Every path, variable, detection signal, file format and command in `src/harnesses/claude.ts` is a claim, and each has a row here. A claim counts only when one of these settles it:

1. the harness's official documentation: the exact sentence, its URL and the date it was read;
2. the harness's public source, where the documentation is silent: repository, file, line and commit;
3. a real install of the harness: the command run, the harness version and its output.

A claim no source settles is left out of the definition and recorded as undocumented. The definition, its JSON twin in `test/fixtures/harnesses/claude.json` and `claude.test.ts` match this file exactly.

Every page below was read on 2026-10-19, and the plugin loading and security pages again on 2026-10-20. Every command ran with `HOME` and `CLAUDE_CONFIG_DIR` inside a sandbox, no account and no credentials.

## Versions tested

| Program | Version | Released | Installed with |
|---|---|---|---|
| `@anthropic-ai/claude-code` | 2.1.296 | 2026-10-09 (npm `time`) | `npm install --prefix <prefix> --ignore-scripts @anthropic-ai/claude-code@2.1.296`, then `<prefix>/bin/claude` linked to the `claude` binary of `@anthropic-ai/claude-code-linux-x64@2.1.296`, the step the package's postinstall `install.cjs` takes |

`claude --version` prints `2.1.296 (Claude Code)`.

## Claims

| Claim | Source | Quote or output | Version | Result |
|---|---|---|---|---|
| Project root `.claude` | https://code.claude.com/docs/en/skills, "Choose where skills load"; https://code.claude.com/docs/en/sub-agents, "Choose the subagent scope" | "Project \| `.claude/skills/<skill-name>/SKILL.md` \| Sessions in this repository."; "`.claude/agents/` \| Current project" | 2.1.296 | confirmed |
| User root `~/.claude` | Same pages | "Personal \| `~/.claude/skills/<skill-name>/SKILL.md` \| All your projects on this machine"; "`~/.claude/agents/` \| All your projects" | 2.1.296 | confirmed |
| `CLAUDE_CONFIG_DIR` moves the user root | https://code.claude.com/docs/en/env-vars; https://code.claude.com/docs/en/claude-directory | "Override the configuration directory (default: `~/.claude`). All settings, session history, and plugins are stored under this path."; "If you set `CLAUDE_CONFIG_DIR`, every `~/.claude` path on this page lives under that directory instead." | 2.1.296 | confirmed |
| The same, by install | `claude -p /context` with a skill `moved` in `<sandbox>/alt/skills/` and a skill `home-only` in `<sandbox>/.claude/skills/` | With `CLAUDE_CONFIG_DIR=<sandbox>/alt`: `\| moved \| User \| < 20 \|`, no `home-only`. Without the variable: `\| home-only \| User \| < 20 \|`, no `moved` | 2.1.296 | confirmed |
| Detected by `CLAUDE_CONFIG_DIR` being set | https://code.claude.com/docs/en/env-vars | The variable is Claude Code's own: "Override the configuration directory (default: `~/.claude`)." | 2.1.296 | confirmed |
| Detected by the program `claude` | The npm package's `package.json`; install | `"bin": { "claude": "bin/claude.exe" }`; `claude --version` prints `2.1.296 (Claude Code)` | 2.1.296 | confirmed |
| Caller variable `CLAUDECODE` | https://code.claude.com/docs/en/env-vars | "Set to `1` in subprocesses Claude Code spawns (Bash and PowerShell tools, tmux sessions, hook commands, status line commands, stdio MCP server subprocesses)." | 2.1.296 | confirmed |
| Caller variable `CLAUDE_CODE` | https://code.claude.com/docs/en/env-vars; the 2.1.296 binary | No page names it. `grep -ac '"CLAUDE_CODE"'` on the binary prints `0`, and no other form of the bare name appears in it; the binary sets `CLAUDECODE:"1"` in each child environment it builds | 2.1.296 | wrong: Claude Code does not set it; removed from `detect.caller` |
| Reads only its own folders, so no `reads` | https://code.claude.com/docs/en/skills, https://code.claude.com/docs/en/sub-agents; install | The pages list only `.claude` locations. With `ns/lint`, `ns/reviewer` and the `kit` namespace placed only in `.agents/` and `~/.agents/` (`--for agents`), `claude -p /context` in the project lists no `lint`, `ship`, `reviewer` or `planner`, and `claude plugin list` prints ``No plugins installed. Use `claude plugin install` to install a plugin.`` | 2.1.296 | confirmed |
| Skill at `skills/<name>/SKILL.md` | https://code.claude.com/docs/en/skills | As in the root rows above | 2.1.296 | confirmed |
| A skill folder may be a link | https://code.claude.com/docs/en/skills, "Choose where skills load" | "Symlinked folders: a `<skill-name>` entry in the enterprise, personal, or project location can be a symlink to a directory elsewhere on disk. Claude Code reads `SKILL.md` from the target and loads the skill once even if several locations point at the same target." | 2.1.296 | confirmed |
| A project skill linked into the store loads | `aireg add fx/ns --all --for claude,agents` in a project only, then `claude -p /context` there | `\| lint \| Project \| < 20 \|`, with `.claude/skills/lint` and `.agents/skills/lint` both links to `.registry/artifacts/fx/ns/skills/lint` | 2.1.296 | confirmed |
| A `.claude/skills/<name>` link to a real `.agents/skills/<name>` folder loads | A hand-made project: `.agents/skills/lint/SKILL.md` and `.claude/skills/lint -> ../../.agents/skills/lint`, then `claude -p /context` | `\| lint \| Project \| < 20 \|` | 2.1.296 | confirmed |
| Agent at `agents/<name>.md` | https://code.claude.com/docs/en/sub-agents | As in the root rows above; "Claude Code scans `.claude/agents/` and `~/.claude/agents/` recursively" | 2.1.296 | confirmed |
| An agent file may be a link | The documentation is silent; install | `claude -p /context` in the L2 sandbox: `\| reviewer \| Project \| 9 \|` from the link `.claude/agents/reviewer.md`. `claude plugin validate .claude` warns: "1 entry here is a symlink and was not read — components are read without following symlinks. A session loading this directory does follow them, so validate the real paths separately." | 2.1.296 | confirmed |
| Plugin at `skills/<plugin>/` with `.claude-plugin/plugin.json`, in a project and in your user scope | https://code.claude.com/docs/en/skills; https://code.claude.com/docs/en/plugins/loading | "Skill folder as a plugin: add a `.claude-plugin/plugin.json` to a skill folder and it loads as a plugin named `<name>@skills-dir`, so it can bundle agents, hooks, and MCP servers."; "`@skills-dir` \| You saved a plugin directory that has a `.claude-plugin/plugin.json` under `~/.claude/skills/` or the project's `.claude/skills/`" | 2.1.296 | confirmed |
| The manifest aireg writes, `name` and `description`, loads enabled | https://code.claude.com/docs/en/plugins-reference; `claude plugin validate` on the plugin folder | "`name` \| String \| Plugin identifier, required."; "`defaultEnabled` \| Boolean \| Whether the plugin starts enabled when the user hasn't set it. Defaults to `true`". Validate: two warnings, no `version` and no `author`, then `✔ Validation passed with warnings` | 2.1.296 | confirmed |
| A linked plugin folder, holding linked `skills/` and `agents/`, loads both | https://code.claude.com/docs/en/plugins/loading; L2 probes | "`--plugin-dir` and skills-directory plugins: the directory loads in place and is never copied." `claude plugin details kit`: `Skills (1)  ship`, `Agents (1)  planner` | 2.1.296 | confirmed |
| `plugins/` is never scanned for plugins | https://code.claude.com/docs/en/plugins/loading | "Claude Code doesn't scan a project's `.claude/plugins/` directory." The user `plugins/` holds `known_marketplaces.json`, `installed_plugins.json` and `cache/` | 2.1.296 | confirmed |
| A project's plugin loads only once the project is trusted | https://code.claude.com/docs/en/plugins/loading; `claude plugin list --json` in an untrusted project holding `.claude/skills/toolkit` | "In a folder you haven't trusted: the plugin loads only after you accept the workspace trust dialog for that folder."; "Trusting a parent folder or running with `-p` isn't enough." Output: "1 project-scope directory under ./.claude/skills/ that may load as a plugin was skipped because this workspace was not trusted when plugins were scanned." | 2.1.296 | confirmed: `trust: { plugin: { run: "claude", scope: "project" } }` |
| Starting `claude` in a project asks to trust it | https://code.claude.com/docs/en/security, "Additional safeguards" | "In an interactive session, Claude Code shows the workspace trust dialog when you start it in a folder you haven't trusted." | 2.1.296 | confirmed: the step aireg prints is `claude`, never run |
| Skills and agents in a project need no trust step | https://code.claude.com/docs/en/permissions, "What runs before you trust a folder" | Only "Frontmatter hooks in a project subagent, a project `@skills-dir` plugin, and `extraKnownMarketplaces` entries" and inline `mcpServers` of a project subagent wait for trust; a project skill's hooks and `allowed-tools` are "Used". The trust dialog has no command: "trust it by hand: set `projects["<path>"].hasTrustDialogAccepted` to `true` in `~/.claude.json`", which aireg never writes | 2.1.296 | confirmed: `trust` names plugins alone |
| No reload step for skills and agents | https://code.claude.com/docs/en/skills; https://code.claude.com/docs/en/sub-agents | "When you add, edit, or remove a skill under `~/.claude/skills/`, the project `.claude/skills/`, or a `.claude/skills/` inside an `--add-dir` directory, Claude Code picks up the change within the current session, without a restart."; "Claude Code watches `~/.claude/agents/` and `.claude/agents/`." | 2.1.296 | confirmed |
| A plugin change needs `/reload-plugins` | https://code.claude.com/docs/en/plugins/loading | "Changes to settings or to disk don't reach this layer until you run `/reload-plugins` or start a new session." | 2.1.296 | confirmed; not a `reload` entry, see Left out |
| `verified.command`: `claude --version` | Install | `2.1.296 (Claude Code)` | 2.1.296 | confirmed |
| A plugin's commands load from its folder | https://code.claude.com/docs/en/plugins-reference; `claude plugin details toolkit` for a plugin holding `commands/deploy.md` and `skills/ship/` | "Commands \| `commands/` \| Flat Markdown command files." Output: `Skills (2)  deploy, ship` | 2.1.296 | confirmed: Claude Code takes the whole plugin, so its commands are not written as skills |

Result is `confirmed`, `wrong` (with what is right) or `undocumented`.

## L2 probes

The harness's own commands that list what aireg placed, and what each printed. `claude.test.ts` runs the first three after installing the fixtures in the project and in the user scope.

- `claude plugin list --json`, from the home folder (https://code.claude.com/docs/en/plugins/cli-reference, "plugin list"):
  ```json
  [
    {
      "id": "kit@skills-dir",
      "version": "unknown",
      "scope": "user",
      "enabled": true,
      "installPath": "<sandbox>/.claude/skills/kit"
    }
  ]
  ```
- `claude plugin details kit`, from the home folder ("plugin details": "The plugin must be loaded: installed, found in a skills directory, or passed with `--plugin-dir` or `--plugin-url` in the same command."):
  ```text
  Component inventory
    Skills (1)  ship
    Agents (1)  planner
  ```
- `claude -p /context`, from the project. Claude Code has no command that lists skills or agents without a session. This one starts a print-mode session and runs the local `/context` command, which lists what the session loaded and exits 0 without an account. It writes no trust state: the only change to `.claude.json` is a `pluginUsage` record.
  ```text
  | kit:planner | Plugin | 9 |
  | reviewer | Project | 9 |
  | lint | User | < 20 |
  | kit:ship | Plugin (kit) | < 20 |
  ```
  `lint` shows as `User` because a personal skill wins over a project skill with the same name. The project placement alone shows as `Project`, as in the claims above.
- `claude plugin validate .claude` and `claude plugin validate ~/.claude` validate without following links, and only warn that a session follows them.

## Left out

- **`reload`.** It is printed after every change to a harness, but Claude Code picks up skill and agent changes on its own, and only a plugin change needs `/reload-plugins`.
- **`CLAUDE_CODE`** as a caller variable: Claude Code 2.1.296 does not set it.
- **A shared copy for `.claude/skills` and `.agents/skills`.** When both get a skill, aireg already links both folders to the one copy in the scope's `.registry/`, so there is one copy on disk, and Claude Code loads the linked folder and loads the skill once. With `--copy`, each folder gets its own real copy, as that option asks.
