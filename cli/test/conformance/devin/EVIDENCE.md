# Devin evidence

Every path, variable, detection signal, file format and command in `src/targets/devin.ts` is a claim, and each has a row here. A claim counts only when one of these settles it:

1. the target's official documentation: the exact sentence, its URL and the date it was read;
2. the target's public source, where the documentation is silent: repository, file, line and commit;
3. a real install of the target: the command run, the target version and its output.

A claim no source settles is left out of the definition and recorded as undocumented. The definition, its JSON twin in `test/fixtures/targets/devin.json` and `devin.test.ts` match this file exactly.

This target is Devin Desktop, formerly Windsurf, and the Devin CLI (`devin`). Devin Desktop runs the Devin CLI as its agent, so one definition serves both. Every page below was read on 2026-11-27. Pages under `https://docs.devin.ai/cli/` are also shipped inside the CLI package, at `share/devin/docs/`, and the quotes were checked against the 3000.15.14 copy. Cognition publishes no source for either program. Install rows come from the programs run with `HOME` set to a sandbox folder (`<sandbox>` below), a `PATH` of only `/usr/bin:/bin`, and no sign-in.

## Versions tested

| Program | Version | Released | Installed with |
|---|---|---|---|
| Devin CLI (`devin`) | 3000.15.14 | 2026-11-25 (https://docs.devin.ai/cli/changelog/stable.md) | `devin-3000.15.14-aarch64-apple-darwin.tar.gz` from `https://static.devin.ai/cli/3000.15.14/`, the URL `https://static.devin.ai/cli/current/manifest.json` names, its SHA-256 equal to the manifest's (`23911fdf9b5c…`), unpacked into a sandbox folder instead of running the piped installer (`curl -fsSL https://cli.devin.ai/install.sh \| bash`, https://docs.devin.ai/cli/index.md). `codesign` shows `Authority=Developer ID Application: EXAFUNCTION, INC. (83Z2LHX6XW)`. `devin --version` printed `devin 3000.15.14 (cfa79668e1a5)`. |
| Devin Desktop | 3.14.30833 | Homebrew cask `devin-desktop` (https://formulae.brew.sh/cask/devin-desktop) | `Devin-darwin-arm64-3.14.30833.dmg`, the cask's URL, its SHA-256 equal to the cask's (`153c1be68404…`), mounted read-only. `spctl` reports `source=Notarized Developer ID` for `Devin.app`, signed by the same team. The app bundles its agent at `Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin`, which printed `devin 3000.14.30833 (a165b2eb0a68)`; the rows below marked 3000.14.30833 ran that binary. |

## Claims

| Claim | Source | Quote or output | Version | Result |
|---|---|---|---|---|
| Windsurf is now Devin Desktop | https://docs.devin.ai/desktop/devin-desktop-faq.md | "On June 2, 2026, Windsurf is becoming Devin Desktop." | docs | confirmed: the industry name, and so the id, is Devin |
| Devin Desktop and the CLI share one agent | https://docs.devin.ai/desktop/devin-local/customizations.md; install | "Because Devin Local shares its agent harness with [Devin CLI](https://cli.devin.ai), every customization uses the Devin CLI format and discovery, and a customization you write for one works in the other."; `Devin.app` ships the `devin` binary above | docs, 3000.14.30833 | confirmed: one target serves both |
| Project root `.devin` | https://docs.devin.ai/desktop/devin-local/customizations.md; https://docs.devin.ai/cli/extensibility/skills/overview.md | "\| Workspace \| `.devin/skills/<name>/` (`.agents/skills/` and the legacy `.windsurf/skills/` are also read) \| Current workspace only. Committed with your repo. \|"; "\| `.devin/skills/<name>/SKILL.md` \| Project-specific \| Yes \|" | docs | confirmed |
| User root `~/.config/devin` | https://docs.devin.ai/desktop/devin-local/customizations.md; https://docs.devin.ai/cli/extensibility/skills/overview.md | "\| Global \| `~/.config/devin/skills/<name>/` (`~/.agents/skills/` is also read) \| All workspaces on your machine. Not committed. \|"; "**Global skills** live in `~/.config/devin/skills/` (following [XDG conventions](https://specifications.freedesktop.org/basedir-spec/latest/))" | docs | confirmed |
| `XDG_CONFIG_HOME` moves the user root to `$XDG_CONFIG_HOME/devin` | `devin skills paths`, `devin skills list`, `devin mcp list` and `devin doctor` with `XDG_CONFIG_HOME=<sandbox>/xdg` | `User skills (global): <sandbox>/xdg/devin/skills/<skill-name>/SKILL.md`; a skill, an agent and an MCP server under `<sandbox>/xdg/devin` listed, and those under `~/.config/devin` not | 3000.15.14 | confirmed: `roots.user.env` is `XDG_CONFIG_HOME`, `within` is `devin` |
| On Windows the user root is `%APPDATA%\devin` | https://docs.devin.ai/cli/reference/configuration/config-file.md; https://docs.devin.ai/cli/extensibility/skills/overview.md; the Windows build | "On Windows, the user config paths are `%APPDATA%\devin\config.json` and `%APPDATA%\devin\mcp_config.json` (e.g. `C:\Users\<you>\AppData\Roaming\devin\config.json`), not `~\.config\devin\`."; "On Windows, use `%APPDATA%\devin\skills\<name>\SKILL.md` (typically `C:\Users\<YourUser>\AppData\Roaming\devin\skills\<name>\SKILL.md`) instead of `~/.config/devin/skills/`."; `devin-3000.15.14-x86_64-pc-windows.zip`, its SHA-256 equal to the manifest's (`7cee2a258d90…`), holds `bin/devin.exe`, which imports `SHGetKnownFolderPath`, the call that returns the folder `%APPDATA%` names | docs, 3000.15.14 | confirmed: `roots.user.windows` is `~/AppData/Roaming/devin`, moved by `APPDATA` |
| `XDG_CONFIG_HOME` moves the user root on Windows too | — | No page says. | — | undocumented: on Windows only `APPDATA` moves it |
| It reads every skill folder the docs name | `devin skills list` from the project, one skill in each folder | `/u-agents … (~/.agents/skills/u-agents)`, `/u-codeium … (~/.codeium/windsurf/skills/u-codeium)`, `/u-devin … (~/.config/devin/skills/u-devin)`, `/p-agents … (./.agents/skills/p-agents)`, `/p-devin … (./.devin/skills/p-devin)`, `/p-windsurf … (./.windsurf/skills/p-windsurf)` | 3000.15.14, 3000.14.30833 | confirmed: `reads.skill` is `devin`, then `universal` |
| It finds a project's `.devin/skills` and `.agents/skills` from a subfolder | `devin skills list` from `project/sub/deep` in a Git repository | `/p-agents … (project/.agents/skills/p-agents)`, `/p-devin … (project/.devin/skills/p-devin)` | 3000.15.14 | confirmed: its own folder can come first |
| A linked skill folder loads | `devin skills list` with skills placed as symlinks, in both scopes | `/p-linked [user,model] (<sandbox>/store/linked-src)`, `/u-linked [user,model] (<sandbox>/store/ulinked)` | 3000.15.14, 3000.14.30833 | confirmed: skills are linked |
| A skill is `skills/<name>/SKILL.md` with front matter | https://docs.devin.ai/cli/extensibility/skills/creating-skills.md | "The directory name is the skill's identifier (used for `/my-skill` invocation). The `SKILL.md` file contains optional YAML frontmatter and the skill's prompt content." | docs | confirmed |
| `disable-model-invocation` keeps the model from running a skill | `devin skills list`, one skill with `disable-model-invocation: true` | `/dmi [user] (./.devin/skills/dmi)` beside `/plain [user,model] (./.devin/skills/plain)` | 3000.15.14 | confirmed: no `keys` entry needed |
| A running session sees a skill added to its folder | ACP `session/new`, then a skill written to `.devin/skills/late` | `available_commands_update` listed `early`, then `early` and `late` | 3000.15.14 | confirmed |
| Agent at `.devin/agents/<name>.md` and `~/.config/devin/agents/<name>.md` | https://docs.devin.ai/cli/subagents.md; `devin doctor` | "Custom subagents are defined as markdown files under `agents/`, using either layout: **Flat file** — `agents/<name>.md`"; tabs list `.devin/agents/` and `~/.config/devin/agents/`; `doctor` printed `5 profile(s) loaded: pa-agents, pa-devin, pa-dir, ua-agents, ua-devin` | docs, 3000.15.14 | confirmed |
| Agents need no switch to load | https://docs.devin.ai/cli/subagents.md | "Subagents are on by default." The page marks custom subagents "**experimental**". | docs | confirmed |
| An agent's `model` and `tools` are Devin's own names | https://docs.devin.ai/cli/subagents.md; the binary | The page's example sets `model: sonnet` and `allowed-tools: [read, grep, glob, exec]`, and "`allowed-tools` … The alias `tools` is also accepted."; the binary holds `Unknown model '` and "Subagent has no tools: its profile's allowed-tools match none of the model's tools" | docs, 3000.15.14 | confirmed: the codec keeps `name` and `description`, drops `model`, and refuses to drop `tools` |
| A key Devin does not read is ignored with a warning | `devin doctor`, an agent with `color: red` | `warn  subagent 'a-claude'  CFG005: …/a-claude.md: unsupported frontmatter key(s) ignored: color` | 3000.15.14 | confirmed: the codec drops such keys |
| MCP servers in `.devin/mcp_config.json` and `~/.config/devin/mcp_config.json`, under `mcpServers` | https://docs.devin.ai/desktop/devin-local/customizations.md; https://docs.devin.ai/cli/extensibility/mcp/configuration.md; `devin mcp list` | "\| Project \| `.devin/mcp_config.json` \| Yes (checked into version control) \|" and "\| User \| `~/.config/devin/mcp_config.json` \| No \|"; "Add servers directly to your MCP config file's `mcpServers` section"; `Source: ~/project/.devin/mcp_config.json`, `Source: ~/.config/devin/mcp_config.json` | docs, 3000.15.14 | confirmed |
| A local server as `command`, `args`, `env`; a remote as `url` and `headers` | https://docs.devin.ai/cli/extensibility/mcp/configuration.md | "\| `command` \| string \| Yes \| The executable to run \|", "\| `env` \| object \| No \| Environment variables to set \|", "\| `url` \| string \| Yes \| The URL of the MCP server endpoint \|", "\| `headers` \| object \| No \| Custom HTTP headers to include in requests \|" | docs | confirmed |
| `type` names the transport: `stdio`, `http`, `sse` | `devin mcp list --json`, servers set with `type` | `"type": "stdio"` → `"transport": "stdio"`; `"type": "http"` and `"type": "streamable-http"` → `"transport": "http"`; `"type": "sse"` → `"transport": "sse"` | 3000.15.14 | confirmed: the codec writes `type`; the docs name `transport`, which it reads too |
| `${env:VAR}` expands in `env` and `headers` | ACP `session/new` with `PROBE_TOKEN=s3cr3t`, a project server whose program records its environment, and a remote on `127.0.0.1` that records its requests | the server's environment held `ENVSTYLE=s3cr3t` (from `${env:PROBE_TOKEN}`) and `BRACED=s3cr3t` (from `${PROBE_TOKEN}`); the remote received `POST auth=Bearer s3cr3t` | 3000.15.14 | confirmed: the codec writes `${env:VAR}`, the form the docs show (`"oauthClientSecret": "${env:MY_MCP_CLIENT_SECRET}"`) |
| `disabledTools` denies tools; there is no allow list | https://docs.devin.ai/cli/extensibility/mcp/configuration.md; `devin mcp list` | "\| `disabledTools` \| string[] \| No \| Tool names on this server to hide from the agent. Also accepted on stdio servers. \|"; `Disabled tools: delete_issue` | docs, 3000.15.14 | confirmed: `tools.deny` only |
| A running session does not start a server added to its file | ACP `session/new` with server `first`, then `second` written to `.devin/mcp_config.json` | only `first` started | 3000.15.14 | confirmed: the reload hint asks for a new session |
| Reload after a change | the two rows above | — | 3000.15.14 | confirmed: "Start a new Devin session to load the change." |
| Detected by program `devin` | https://docs.devin.ai/desktop/devin-desktop-faq.md; install | "\| macOS / Linux \| `~/.local/bin/` \| `devin` \|"; the archive holds `bin/devin` | docs, 3000.15.14 | confirmed |
| Detected by program `devin-desktop` | https://docs.devin.ai/desktop/devin-desktop-faq.md; install | "The `surf` shell command has been replaced by the `devin-desktop` command. To install it, open the command palette in Devin Desktop and run **Shell Command: Install 'devin-desktop' command in PATH**."; the app holds `Contents/Resources/app/bin/devin-desktop` | docs, 3.14.30833 | confirmed |
| Detected by `~/.devin` | https://docs.devin.ai/desktop/devin-desktop-faq.md | "Extensions are stored in the dot-folder derived from the product name." with "\| `~/.windsurf/extensions/` \| `~/.devin/extensions/` \|"; the paths it lists for macOS include "`~/.devin/`" | docs | confirmed |
| Not detected by `~/.codeium/windsurf` | https://docs.devin.ai/desktop/devin-desktop-faq.md | "The `~/.codeium/` directory structure is not changing in this release." Other skill installers also create `~/.codeium/windsurf/skills` for Windsurf, so the folder does not prove Devin is installed. | docs | confirmed: left out of `detect.paths` |
| `windsurf` is not a program on `PATH` | https://docs.devin.ai/desktop/devin-desktop-faq.md | "The legacy `surf` (and `windsurf`) commands still ship in `~/.codeium/windsurf/bin/` for backward compatibility." | docs | confirmed: not a detection signal |
| No variable marks a command run by Devin | https://docs.devin.ai/cli/reference/configuration/config-file.md | No page names one. | docs | undocumented: no `detect.caller` |
| Plugins install only through `devin plugins install`, signed in | https://docs.devin.ai/cli/extensibility/plugins/overview.md; `devin plugins list` | "A local folder can't be recorded in your personal manifest, so install one with `--local`, which links it on this machine. Managing plugins requires being signed in (`devin auth login`)"; `Error: You must be logged in to manage plugins. Run `devin auth login` first.` | docs, 3000.15.14 | confirmed: a plugin lands as its parts (`shape: "contents"`) |
| Version command | `devin --version` | `devin 3000.15.14 (cfa79668e1a5)`; `devin 3000.14.30833 (a165b2eb0a68)` | 3000.15.14, 3000.14.30833 | confirmed |

Result is `confirmed`, `wrong` (with what is right) or `undocumented`.

## L2 probes

The target's own commands that list what aireg placed. `devin.test.ts` runs them after installing the fixtures in the project and in the user scope, with `--process-model in-process` so no daemon starts. Devin CLI 3000.15.14 and Devin Desktop 3.14.30833's agent (3000.14.30833) passed them. Neither needs a sign-in.

- `devin skills list` (https://docs.devin.ai/cli/reference/commands.md: "\| `devin skills list` \| List all available skills \|"). It prints a linked skill at the path the link resolves to. When both scopes hold the same name, it prefixes each with the project's path. From the project, after `aireg add` of `examples/acme-registry`'s `pr-review`:
  ```text
  /pr-review [user,model] (./.registry/artifacts/acme/engineering/skills/pr-review) - Review a pull request for correctness, clarity, and test coverage, and leave findings ranked by severity. Uses a checklist and a scoring rubric.
  ```
- `devin doctor` (same page: "It reports which [custom subagent](/cli/subagents#custom-subagents) profiles loaded"). After `aireg add` of that registry's `reviewer` agent:
  ```text
  pass  custom subagent profiles   1 profile(s) loaded: reviewer
  ```
- `devin mcp list --json` (same page: "\| `devin mcp list` \| List all configured MCP servers \|"). After `aireg install` of `engineering/issue-tracker` with `tools: { deny: [delete_issue] }`, it listed `"transport": "http"`, `"disabled_tools": ["delete_issue"]` and `"source": "~/project/.devin/mcp_config.json"`. After `aireg remove`, it printed `No MCP servers configured.` `test/conformance/mcp.test.ts` checks the files aireg writes.

Not available without a session:

- **Plugins.** `devin plugins list` needs a sign-in, as above.

## Left out

- **`windsurf` as an alias.** An alias keeps an id from aireg 0.1 working. `windsurf` was never an aireg id, and the program is now called Devin.
- **Rules, `AGENTS.md` and workflows.** Rules (`.devin/rules/*.md`) and `AGENTS.md` are always-on context, not an aireg kind. Devin Desktop's own agent does not run workflows: "Workflows are specific to Cascade — Devin Local does not support them." (https://docs.devin.ai/desktop/cascade).
- **`.windsurf` and `~/.codeium/windsurf`.** Devin still reads both, as rows above show. The docs call `.windsurf/skills` "legacy", so aireg writes Devin's own folders.
- **A project's `.agents/agents`.** Devin reads it, but other tools' agents land there as written, with `tools` lists Devin would read as its own. aireg writes Devin's agents in `.devin/agents` through the codec.
- **An MCP server's allow list.** Devin has no per-server allow list, so a server that allows only some tools is left out for Devin, with the reason printed.
