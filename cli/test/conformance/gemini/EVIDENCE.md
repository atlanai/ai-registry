# Gemini CLI evidence

Every path, variable, detection signal, file format and command in `src/targets/gemini.ts` is a claim, and each has a row here. A claim counts only when one of these settles it:

1. the target's official documentation: the exact sentence, its URL and the date it was read;
2. the target's public source, where the documentation is silent: repository, file, line and commit;
3. a real install of the target: the command run, the target version and its output.

A claim no source settles is left out of the definition and recorded as undocumented. The definition, its JSON twin in `test/fixtures/targets/gemini.json` and `gemini.test.ts` match this file exactly.

Every page below was read on 2026-10-19, as the Markdown copy the site serves at the URL given. Source lines are in https://github.com/google-gemini/gemini-cli at tag `v0.63.0`, commit `573846625af9e93b3b968e0e0b86bb093a4c9b16`, the release tested. Install output comes from Gemini CLI 0.63.0 run with `HOME` and `GEMINI_CLI_HOME` set to a sandbox folder (`<sandbox>` below), with no account.

## Versions tested

| Program | Version | Released | Installed with |
|---|---|---|---|
| Gemini CLI (`gemini`) | 0.63.0 | 2026-10-06 (`npm view @google/gemini-cli time` gives `2026-10-06T20:58:43.642Z`; 0.64.0 came out on 2026-10-13) | `npm install --prefix <prefix> --ignore-scripts @google/gemini-cli@0.63.0`, the package https://geminicli.com/docs/get-started/installation.md names (`npm install -g @google/gemini-cli`). The package declares no install scripts. `gemini --version` printed `0.63.0`. |

## Claims

| Claim | Source | Quote or output | Version | Result |
|---|---|---|---|---|
| Project root `.gemini` | https://geminicli.com/docs/cli/skills.md; https://geminicli.com/docs/core/subagents.md | "**Workspace skills**: Located in `.gemini/skills/` or the `.agents/skills/` alias." and "**Project-level:** `.gemini/agents/*.md` (Shared with your team)" | docs | confirmed |
| User root `~/.gemini` | https://geminicli.com/docs/cli/skills.md; https://geminicli.com/docs/core/subagents.md | "**User skills**: Located in `~/.gemini/skills/` or the `~/.agents/skills/` alias." and "**User-level:** `~/.gemini/agents/*.md` (Personal agents)" | docs | confirmed |
| `GEMINI_CLI_HOME` names the folder that holds the user root (`within: ".gemini"`) | https://geminicli.com/docs/reference/configuration.md; `packages/core/src/utils/paths.ts:22-28`, `packages/core/src/config/storage.ts:54-60` | "Specifies the root directory for Gemini CLI's user-level configuration and storage. By default, this is the user's system home directory. The CLI will create a `.gemini` folder inside this directory." In the source, `homedir()` returns `process.env['GEMINI_CLI_HOME']` when set, and the user folder is `path.join(homeDir, GEMINI_DIR)`. | 0.63.0 | confirmed |
| `GEMINI_CLI_HOME` also moves the user `.agents` folder | `packages/core/src/config/storage.ts:62-68`, `:146-148` | `getGlobalAgentsDir()` is `path.join(homeDir, AGENTS_DIR_NAME)` under the same `homedir()`, and user skills are read from its `skills`. The docs are silent. | 0.63.0 | confirmed; the shared `~/.agents` folder does not follow the variable, so the skill mapping prefers `.gemini` (see Left out) |
| Detected by `GEMINI_CLI_HOME` | https://geminicli.com/docs/reference/configuration.md | The same entry: a variable only Gemini CLI reads. | docs | confirmed |
| Program `gemini` | https://geminicli.com/docs/cli/cli-reference.md; `packages/cli/package.json:13` | "`gemini skills list` \| List all discovered agent skills"; `"gemini": "dist/index.js"`. The install put `gemini` in `node_modules/.bin`. | 0.63.0 | confirmed |
| Caller `GEMINI_CLI` | https://geminicli.com/docs/tools/shell.md; `packages/core/src/services/shellExecutionService.ts:59-64`, `:584-585` | "When `run_shell_command` executes a command, it sets the `GEMINI_CLI=1` environment variable in the subprocess's environment. This allows scripts or tools to detect if they are being run from within Gemini CLI." | 0.63.0 | confirmed |
| A skill is `skills/<name>/SKILL.md`, one level deep | https://geminicli.com/docs/cli/skills.md; `packages/core/src/skills/skillLoader.ts:127-133` | "a "skill" is a self-contained directory that packages instructions and assets"; the loader globs `['SKILL.md', '*/SKILL.md']` in each skills folder. | 0.63.0 | confirmed |
| Reads skills from `.agents` too | https://geminicli.com/docs/cli/skills.md | "**User skills**: Located in `~/.gemini/skills/` or the `~/.agents/skills/` alias." and "**Workspace skills**: Located in `.gemini/skills/` or the `.agents/skills/` alias." | docs | confirmed |
| A skill in both `.gemini/skills` and `.agents/skills` loads once, with a warning | https://geminicli.com/docs/cli/skills.md; `packages/core/src/skills/skillManager.ts:129-143` | "Within the same tier (user or workspace), the `.agents/skills/` alias takes precedence over the `.gemini/skills/` directory." The source emits `Skill conflict detected: "<name>" from "<location>" is overriding the same skill from "<location>".` | 0.63.0 | confirmed: one folder per skill, never both |
| A linked skill folder loads | `gemini skills list` in the sandbox, after `aireg add -g` linked `~/.gemini/skills/lint` | `lint [Enabled]` … `Location:    <sandbox>/.gemini/skills/lint/SKILL.md` | 0.63.0 | confirmed |
| Project skills load only in a trusted folder | `packages/core/src/skills/skillManager.ts:81-87` | `if (!isTrusted) { debugLogger.debug('Workspace skills disabled because folder is not trusted.'); return; }`, before both project folders are read. The docs are silent. | 0.63.0 | confirmed |
| Agent at `.gemini/agents/<name>.md`, `~/.gemini/agents/<name>.md` | https://geminicli.com/docs/core/subagents.md | "Custom agents are defined as Markdown files (`.md`) with YAML frontmatter." and the two paths above | docs | confirmed |
| Agent front matter is strict: an unknown key fails the agent | `packages/core/src/agents/agentLoader.ts:92-116`; a file in `~/.gemini/agents` with `colour: red`, then `gemini skills list` | The local agent schema ends `.strict()`. Output: `Agent loading error: Failed to load agent from <sandbox>/.gemini/agents/bad.md: Validation failed: Agent Definition:` / `Unrecognized key(s) in object: 'colour'` | 0.63.0 | confirmed: `frontmatter-strict` |
| The keys an agent may set: `kind`, `name`, `description`, `display_name`, `tools`, `mcp_servers`, `model`, `temperature`, `max_turns`, `timeout_mins` | `packages/core/src/agents/agentLoader.ts:92-116`; a file setting all ten, then `gemini skills list` | The schema's keys are those ten. The file loaded with no error. | 0.63.0 | confirmed: the codec's `keep` |
| The docs' key `mcpServers` | https://geminicli.com/docs/core/subagents.md; a file setting `mcpServers: {}` | The table names "`mcpServers` \| object \| No", and leaves out `display_name`. Output: `Unrecognized key(s) in object: 'mcpServers'` | 0.63.0 | wrong: the key is `mcp_servers` |
| `name` is a slug | https://geminicli.com/docs/core/subagents.md; `packages/core/src/agents/agentLoader.ts:50-52` | "Unique identifier (slug) used as the tool name for the agent. Only lowercase letters, numbers, hyphens, and underscores." An agent name in a registry is always one. | 0.63.0 | confirmed |
| `tools` is a list of Gemini CLI tool names | https://geminicli.com/docs/core/subagents.md; `packages/core/src/agents/agentLoader.ts:98-109`; files setting `tools: Read, Grep` and `tools: [Read]` | "List of tool names this agent can use. … **If omitted, it inherits all tools from the parent session.**" Output: `(Local Agent) tools: Expected array, received string` and `tools.0: Invalid tool name`; `tools: [read_file]` loaded. | 0.63.0 | confirmed: kept as written, so an agent whose `tools` Gemini CLI cannot read fails to load rather than run with every tool |
| A linked agent file is skipped | `packages/core/src/agents/agentLoader.ts:665-670`; the same invalid file as a link in `~/.gemini/agents` | The loader keeps only `entry.isFile()`, which is false for a link. As a link, the invalid file printed no error; copied, it did. | 0.63.0 | confirmed: an agent is written as a file |
| Project agents load only in a trusted folder | `packages/core/src/agents/registry.ts:174-233`; `gemini skills list` in the sandbox project | `Skipping project agents due to untrusted folder. To enable, ensure that the project root is trusted.` | 0.63.0 | confirmed |
| A project agent also needs acknowledging, by the hash of its file | `packages/core/src/agents/registry.ts:186-214`, `packages/core/src/agents/acknowledgedAgents.ts` | An agent is registered only when `ackService.isAcknowledged(projectRoot, agent.name, agent.metadata.hash)`; otherwise the session lists it as discovered and asks. The docs are silent. | 0.63.0 | confirmed; asked in a session, with no command, so report only |
| Folder trust is on by default | https://geminicli.com/docs/reference/configuration.md; https://geminicli.com/docs/cli/trusted-folders.md; `packages/cli/src/config/settingsSchema.ts:1915-1921` | "**`security.folderTrust.enabled`** … **Default:** `true`", while the trusted folders page says "The Trusted Folders feature is **disabled by default**." The schema's default is `true`, and the install skipped project agents with no settings file. | 0.63.0 | confirmed: on |
| The trust step is `/permissions trust`, at project scope | https://geminicli.com/docs/reference/commands.md; https://geminicli.com/docs/cli/trusted-folders.md; `packages/cli/src/ui/commands/permissionsCommand.ts:18-28` | "**`trust`**: … **Description:** Manage folder trust settings. … **Usage:** `/permissions trust [<directory-path>]`" and "**Change the current folder's trust**: Run the `/permissions` command from within the CLI." Not run here. | 0.63.0 | confirmed: `trust` for `skill` and `agent` at `project` |
| No shell command trusts a folder | https://geminicli.com/docs/cli/trusted-folders.md; https://geminicli.com/docs/cli/cli-reference.md | "Your choice is saved in a central file (`~/.gemini/trustedFolders.json`)". `--skip-trust` and `GEMINI_CLI_TRUST_WORKSPACE=true` "trust the current workspace for the duration of the session", which is not a step a person takes once. | docs | confirmed |
| Extension at `~/.gemini/extensions/<name>/gemini-extension.json`, user scope only | https://geminicli.com/docs/extensions/reference.md; `packages/cli/src/config/extension-manager.ts:624-633`, `:1031-1035` | "Gemini CLI loads extensions from `<home>/.gemini/extensions`. Each extension must have a `gemini-extension.json` file in its root directory." The loader refuses a manifest missing `"name"` or `"version"`. | 0.63.0 | confirmed, not used (see Left out) |
| A linked extension folder loads, with its `skills/` and `agents/` | https://geminicli.com/docs/extensions/reference.md; `packages/cli/src/config/extension-manager.ts:911-943`; `gemini extensions list` with `~/.gemini/extensions/kit` linked to aireg's plugin folder | "Place skill definitions in a `skills/` directory." and "Add agent definition files (`.md`) to an `agents/` directory in your extension root." Output: `✓ kit (0.0.0)` … `Agent skills:` / `ship: Ships a change.` | 0.63.0 | confirmed, not used (see Left out) |
| An extension's agents are read as written, beside the converted copy | `gemini skills list` with that extension and `~/.gemini/agents/planner.md` written by the codec | `Duplicate agent name 'planner' detected. The later definition will be ignored. Rename one of the agents to avoid this conflict.` | 0.63.0 | confirmed: the reason a plugin lands as its parts |
| Reload after a change | https://geminicli.com/docs/cli/skills.md; https://geminicli.com/docs/reference/commands.md | "At the start of a session, Gemini CLI scans the discovery tiers", "`/skills reload` (or `/skills refresh`): Refreshes the list of discovered skills from all tiers." and "`/agents reload` … Rescans agent directories (`~/.gemini/agents` and `.gemini/agents`) and reloads the registry." | docs | confirmed |
| Version command | https://geminicli.com/docs/cli/cli-reference.md | "`--version` \| `-v` \| … \| Show CLI version number and exit"; `gemini --version` printed `0.63.0` | 0.63.0 | confirmed |
| Without `keys`, a plugin's command loads as a skill like any other | `aireg add <plugin folder> --all --for gemini`, the plugin holding `commands/deploy.md`, then `gemini skills list` | `toolkit-deploy [Enabled]`, `Location: <sandbox>/home/.gemini/skills/toolkit-deploy/SKILL.md` | 0.63.0 | confirmed |
| `disable-model-invocation` keeps the model from running that skill on its own | https://geminicli.com/docs/cli/skills.md, read 2026-10-20; the installed package | The page names no such key, and no file of the 0.63.0 package holds the string `disable-model-invocation` With the key set to `false`, `aireg add <plugin folder> --all` printed `warning: Did not install toolkit-deploy for Gemini CLI: it sets disable-model-invocation, which Gemini CLI cannot read.`; `gemini skills list` lists `lint` and `ship`, not `toolkit-deploy` | 0.63.0 | wrong: `keys` sets it to `false`, so a skill that sets it is left out |

Result is `confirmed`, `wrong` (with what is right) or `undocumented`.

## L2 probes

The target's own commands that list what aireg placed, and what each printed. `gemini.test.ts` runs both after installing the fixtures in the project and in the user scope, with `GEMINI_CLI_HOME` set to the sandbox home.

- `gemini skills list`, from the home folder (https://geminicli.com/docs/cli/cli-reference.md, "List all discovered agent skills"). It needs no account. It also loads every agent as the CLI starts and prints each one it fails to load, so the test checks it printed none:
  ```text
  Discovered Agent Skills:

  lint [Enabled]
    Description: Lints a change.
    Location:    <sandbox>/.gemini/skills/lint/SKILL.md

  ship [Enabled]
    Description: Ships a change.
    Location:    <sandbox>/.gemini/skills/ship/SKILL.md
  ```
- `gemini skills list`, from the project, which is not trusted, so it lists the same user skills and says why it skips the project's:
  ```text
  Skipping project agents due to untrusted folder. To enable, ensure that the project root is trusted.
  ```

Not available:

- **Agents.** No command lists them outside a session: `/agents list` is a slash command, and `gemini -p "/agents list"` printed `Please set an Auth method in your <sandbox>/.gemini/settings.json or specify one of the following environment variables before running: …` and exited 41. The probe above shows the strict loader accepted every agent aireg wrote, and the duplicate-name warning in the claims shows it read `~/.gemini/agents/planner.md`.
- **Project skills and agents.** Gemini CLI reads them only in a trusted folder, and nothing here trusts one, so they are checked at L1 only.

## Left out

- **`plugin` as an extension.** Gemini CLI loads a linked `~/.gemini/extensions/<plugin>/` with a `gemini-extension.json` (aireg's manifest plus a fixed `version`), but it reads the extension's `agents/` as written, linked or copied (`place: "copy"` copies the same folder), beside the copy the agent codec writes to `~/.gemini/agents/`, and warns of a duplicate agent; an agent with keys Gemini CLI does not read would fail to load there. Until aireg leaves out of a plugin folder the kinds a target rewrites, a namespace lands as its parts (`shape: "contents"`): its skills in `~/.gemini/skills/`, its agents in `~/.gemini/agents/`.
- **`.agents` before `.gemini` for skills.** Gemini CLI reads both, but finds the user `.agents` folder under `GEMINI_CLI_HOME`, which the shared `~/.agents` folder does not follow. So a skill for Gemini CLI alone lands in `.gemini/skills/`, and only one shared with a target that reads `.agents` alone lands in `.agents/skills/`; with `GEMINI_CLI_HOME` set to another folder, Gemini CLI does not see that shared user copy.
- **The project agent acknowledgement.** Gemini CLI asks for it in a session, for each agent and again after each change to its file; no command takes it, so it is described, not a `trust` entry.
- **`restrictions` on the agent codec.** Gemini CLI reads `tools`, the one key that limits an agent here, so the codec keeps it as written. The keys other targets limit an agent with (`allowed-tools`, `disallowedTools`, `permissionMode`, `permission`) are ones Gemini CLI cannot read, and the codec refuses to drop them by default, so an agent that sets one is not written for Gemini CLI.
