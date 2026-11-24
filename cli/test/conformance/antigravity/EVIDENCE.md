# Google Antigravity evidence

Every path, variable, detection signal, file format and command in `src/targets/antigravity.ts` is a claim, and each has a row here. A claim counts only when one of these settles it:

1. the target's official documentation: the exact sentence, its URL and the date it was read;
2. the target's public source, where the documentation is silent: repository, file, line and commit;
3. a real install of the target: the command run, the target version and its output.

A claim no source settles is left out of the definition and recorded as undocumented. The definition, its JSON twin in `test/fixtures/targets/antigravity.json` and `antigravity.test.ts` match this file exactly.

This target is Google Antigravity's App, its standalone IDE and its CLI (`agy`), which share one customization folder, `~/.gemini/config`. Every page below was read on 2026-10-29, as the Markdown copy the site serves at the URL given (`https://antigravity.google/docs/<page>.md`). Google publishes no source for these programs. Install rows come from the Antigravity CLI 1.4.5 run with `HOME` set to a sandbox folder (`<sandbox>` below), `AGY_CLI_DISABLE_AUTO_UPDATE=true` and no sign-in.

## Versions tested

| Program | Version | Released | Installed with |
|---|---|---|---|
| Antigravity App | 2.28.1 (docs) | 2026-10-28 (https://antigravity.google/docs/changelog.md: "v2.28.1 … Latest … October 28, 2026") | Not installed: Google ships it only as a desktop image downloaded from its website (https://antigravity.google/docs/getting-started.md), with no registry package. |
| Antigravity IDE | 2.6.0 (docs) | 2026-10-26 (changelog: "Antigravity IDE … v2.6.0 … Latest … October 26, 2026") | Not installed, for the same reason. |
| Antigravity CLI (`agy`) | 1.4.5 | 2026-10-22 (https://github.com/google-antigravity/antigravity-cli/releases/tag/1.4.5); the latest, 1.4.10, came out on 2026-10-29 | `agy_cli_mac_arm64.tar.gz` from that release, its SHA-256 equal to the digest GitHub records for the asset (`6d628d7d25df…`), unpacked into a sandbox folder instead of running the piped installer (`curl -fsSL https://antigravity.google/cli/install.sh \| bash`, getting-started.md). `codesign` shows `Authority=Developer ID Application: Google LLC (EQHXZ8M8AV)`, and `spctl` reports `source=Notarized Developer ID`. `agy --version` printed `1.4.5`. |

## Claims

| Claim | Source | Quote or output | Version | Result |
|---|---|---|---|---|
| The App, the IDE and the CLI are Antigravity's three programs | https://antigravity.google/docs/overview.md; https://antigravity.google/docs/getting-started.md | "Evolved from the Agent Manager into a standalone desktop command center (Antigravity App) alongside native terminal, editor, and programmatic SDK interfaces"; "download the standalone **Antigravity IDE**"; "Install the Antigravity CLI (`agy`) binary" | docs | confirmed |
| Project root `.agents` | https://antigravity.google/docs/skills.md; https://antigravity.google/docs/subagents.md | Under the App, IDE and CLI skill locations alike: "`<workspace-root>/.agents/skills/<skill-folder>/` \| Workspace-specific"; "**Workspace Customizations** \| `.agents/agents/<name>.md` or `.agents/agents/<name>/agent.md`" | docs | confirmed: in a project its skill folder is the shared `.agents/skills`, which aireg writes once for both |
| User root `~/.gemini/config` | https://antigravity.google/docs/skills.md; https://antigravity.google/docs/subagents.md | App: "`~/.gemini/config/skills/<skill-folder>/` \| Global (all workspaces)"; IDE: "`~/.gemini/config/skills/<skill-folder>/` \| Global (all workspaces; legacy `~/.gemini/antigravity/skills/` is also supported)"; "**Global Customizations** \| `~/.gemini/config/agents/<name>.md` or `.../agents/<name>/agent.md`" | docs | confirmed |
| The CLI reads `~/.gemini/config` too | https://antigravity.google/docs/commands/learn.md; https://antigravity.google/docs/subagents.md; https://antigravity.google/docs/changelog.md (CLI v1.1.0) | "Available on: Antigravity App, Antigravity CLI, Antigravity IDE" and "`/learn` writes to the same locations that Antigravity discovers customizations from", with "\| **Skill** \| `.agents/skills/<name>/SKILL.md` \| `~/.gemini/config/skills/<name>/SKILL.md` \|"; "**Global agents**: `~/.gemini/config/agents/`"; "ensuring users create global subagents in the location actively scanned during startup discovery" | docs | confirmed: one target serves the CLI as well |
| The CLI's skills table names `~/.gemini/antigravity-cli/skills` | https://antigravity.google/docs/skills.md | Under "CLI skill locations": "`~/.gemini/antigravity-cli/skills/<skill-folder>/` \| Global (all workspaces)" | docs | confirmed, not used: the CLI also discovers `~/.gemini/config/skills` (row above), so one folder serves all three programs |
| It reads no user `~/.agents/skills` | https://antigravity.google/docs/skills.md | No table names `~/.agents/skills`; no page names a user-level `.agents` folder. | docs | confirmed by omission: in your user scope the skill lands in `~/.gemini/config`, never in the shared `~/.agents` |
| `~/.gemini/config` is the folder the programs share | https://antigravity.google/docs/hooks.md; https://antigravity.google/docs/settings.md | "**Global level**: `~/.gemini/config/hooks.json`. Hooks in `~/.gemini/antigravity-cli/settings.json` aren’t loaded."; "**Plugins**: Installed in `~/.gemini/config/plugins/<plugin>/`, or in `<workspace>/.agents/plugins/<plugin>/` for one workspace." | docs | confirmed |
| `~/.gemini/antigravity/skills` and `.agent/skills` are legacy folders | https://antigravity.google/docs/skills.md | "legacy `~/.gemini/antigravity/skills/` is also supported" (IDE table); "**Note**: Antigravity defaults to `.agents/skills`, but still maintains backward compatibility for `.agent/skills`." | docs | confirmed legacy; not used |
| The Vercel skills agents table gives `~/.gemini/antigravity/skills/` as Antigravity's global folder | https://github.com/vercel-labs/skills/blob/f906c463910130dcabae49ca3dd02581f29d6ee8/docs/agents.md, line 12 | "Antigravity \| `antigravity` \| `.agents/skills/` \| `~/.gemini/antigravity/skills/`" | — | wrong: that is the IDE's legacy folder; the current one is `~/.gemini/config/skills/` |
| No variable moves the user root | every page above | No page names one. | docs | undocumented: `roots.user.env` stays unset |
| Not detected by its project folder | https://antigravity.google/docs/skills.md | `.agents` is the folder "Antigravity defaults to", and the shared folder of several other tools, so finding it proves nothing. | docs | confirmed: `detect.projectRoot: false` |
| Detected by program `agy` | https://antigravity.google/docs/getting-started.md; install | "Install the Antigravity CLI (`agy`) binary … Default binary location: `~/.local/bin/agy`"; the release archive holds one program, `antigravity`, run here as `agy` | 1.4.5 | confirmed |
| Detected by `~/.gemini/antigravity` | https://antigravity.google/docs/hooks.md; https://antigravity.google/docs/agent-settings.md | "For the Antigravity App, `<app_data_dir>` in hook payloads resolves to `~/.gemini/antigravity`." and "the application’s local app data directory `~/.gemini/antigravity/` (which contains artifacts, knowledge items, and more)" | docs | confirmed |
| Detected by `~/.gemini/antigravity-ide` | https://antigravity.google/docs/hooks.md | "For Antigravity IDE, `<app_data_dir>` in hook payloads resolves to `~/.gemini/antigravity-ide`." | docs | confirmed |
| A skill is `skills/<name>/SKILL.md`, one level deep | https://antigravity.google/docs/skills.md; https://antigravity.google/docs/changelog.md (CLI v1.2.10) | "Skills are organized as directory bundles containing a required `SKILL.md` file" and "an entry now loads only the items directly inside the directory, the same as a `.agents/skills/` folder" | docs | confirmed |
| A linked skill folder loads | — | No page says. | — | undocumented: skills are written as copies (`place: "copy"`), in a project's shared folder as well (see Left out) |
| The same skill name in two folders | https://antigravity.google/docs/changelog.md (CLI v1.1.21) | "explicitly configured skill and plugin paths take priority over automatically discovered customizations" | docs | undocumented for two discovered folders |
| Skill front matter: `name` (optional, defaults to the folder) and `description` (required) | https://antigravity.google/docs/skills.md | "`name` \| No \| A unique identifier for the skill (lowercase, hyphens for spaces). Defaults to the folder name if not provided." and "`description` \| Yes \| A clear description of what the skill does and when to use it." | docs | confirmed |
| `disable-model-invocation` keeps the model from running that skill on its own | https://antigravity.google/docs/skills.md; https://antigravity.google/docs/changelog.md (CLI v1.1.12) | No page names the key. The only invocation key documented is the opposite, `disable-slash-command`: "Added a `disable-slash-command: true` flag for a skill's `SKILL.md` frontmatter". | docs | undocumented: `keys` sets it to `false`, so a skill that sets it is left out rather than installed without that limit |
| Agent at `~/.gemini/config/agents/<name>.md`, Markdown with YAML front matter | https://antigravity.google/docs/subagents.md | "You can define reusable custom subagents in Markdown format (`.md`) with YAML frontmatter"; the page says "Available on: Antigravity App, Antigravity CLI" | docs | confirmed for the App and the CLI; the IDE is undocumented |
| The CLI loads an agent from `~/.gemini/config/agents` as the codec writes it | `agy agents` from `<sandbox>`, after `aireg add -g` placed `reviewer` and `planner` there; again with `reviewer.md` moved away | `reviewer` and `planner` listed; with the file moved away, `reviewer` is gone | 1.4.5 | confirmed |
| Agent `name` and `description` are required | https://antigravity.google/docs/subagents.md | "`name` \| `string` \| _(Required)_" and "`description` \| `string` \| _(Required)_" | docs | confirmed: the codec keeps both |
| Agent `tools` holds Antigravity tool names, and another tool's names can hang the agent | https://antigravity.google/docs/subagents.md | "**Known issue (tool validation)**: Specifying an unmapped or misspelled tool name in the `tools` list may cause the subagent process to hang during execution." | docs | confirmed: the codec keeps only `name` and `description` and refuses to drop `tools`, so an agent that sets `tools` is not written |
| Agent `model` takes Antigravity's own tiers | https://antigravity.google/docs/subagents.md | "`model` \| `string` \| `inherit` \| Model tier used when invoked (`inherit`, `flash`, or `pro`)." | docs | confirmed: the codec leaves `model` out |
| A linked agent file loads | — | No page says. | — | undocumented: the codec writes a real file |
| Project skills and agents load only in a trusted folder | https://antigravity.google/docs/getting-started.md | "**Workspace trust**: Confirm that you trust the repository directory before the agent begins file indexing." No page names a command that trusts a folder, or says what an untrusted folder skips. | docs | undocumented: no `trust` entry |
| Reload after a change | https://antigravity.google/docs/skills.md; https://antigravity.google/docs/cli/reference.md | "When you start a conversation, the agent sees a list of available skills with their names and descriptions." and "**`/skills`** … Browse loaded local and global Agent Skills. Run `/skills reload` to reload skills from disk." | docs | confirmed |
| Version command | https://antigravity.google/docs/getting-started.md; install | "Open a terminal window and verify the installation: `agy --version`", which printed `1.4.5`; no page names one for the App or the IDE. | 1.4.5 | confirmed: `verified` names the CLI |
| Plugin at `.agents/plugins/<name>/plugin.json`, `~/.gemini/config/plugins/<name>/plugin.json` | https://antigravity.google/docs/plugins.md | "**Workspace level**: Place your plugin folder in `.agents/plugins/` at the root of your workspace." and "**Global level**: Place your plugin folder in `~/.gemini/config/plugins/`." | docs | confirmed, not used (see Left out) |
| MCP servers in `.agents/mcp_config.json` and `~/.gemini/config/mcp_config.json` under `mcpServers` | https://antigravity.google/docs/mcp.md, read 2026-11-24 | Vendor documentation, as summarized on that date | - | documented, not run |
| A local server as `command`, `args`, `env`; a remote as `serverUrl`, `headers`, streamable HTTP only | https://antigravity.google/docs/mcp.md, read 2026-11-24 | Vendor documentation, as summarized on that date | - | documented, not run |
| No documented secret syntax, so a server that needs a secret is left out | https://antigravity.google/docs/mcp.md, read 2026-11-24 | Vendor documentation, as summarized on that date | - | documented, not run |
| `enabledTools` and `disabledTools` | https://antigravity.google/docs/mcp.md, read 2026-11-24 | Vendor documentation, as summarized on that date | - | documented, not run |

Result is `confirmed`, `wrong` (with what is right) or `undocumented`.

## L2 probes

The target's own command that lists what aireg placed, and what it printed. `antigravity.test.ts` runs it after installing the fixtures in the project and in the user scope, with `AGY_CLI_DISABLE_AUTO_UPDATE=true`; the Antigravity CLI 1.4.5 passed it.

- `agy agents`, from the home folder (https://antigravity.google/docs/cli/commands/agents.md). It needs no sign-in:
  ```text
  reviewer
  planner
  ```

Not available without a session:

- **Skills.** The CLI lists skills only in a signed-in session: `agy -p "/skills"` with no cached credentials printed `Authentication required. Please visit the URL to log in:` and exited 1. The App and the IDE are desktop applications with no command that lists what they loaded.

## Left out

- **Linked skills.** The docs are silent, and a public report against the Vercel skills installer (https://github.com/vercel-labs/skills/issues/633) found Antigravity IDE ignoring symlinked skill folders. Skills are written as copies, and a project's shared `.agents/skills` takes copies too when Antigravity is among the targets reading it.
- **Project agents.** A project's `.agents/agents` holds other tools' agents as they write them, and Antigravity can hang on another tool's `tools` names. aireg writes Antigravity's agents only in your user scope, through the codec, and says so when a project install has none to write.
- **`plugin` as an Antigravity plugin.** A plugin's `agents/` would be read as written, putting another tool's `tools` list in front of a loader that may hang on it, so a plugin lands as its parts (`shape: "contents"`).
- **Agents in the IDE.** The custom subagents page names the App and the CLI only; the IDE reads `~/.gemini/config` for skills, hooks and plugins, so the agent mapping is kept, unconfirmed for the IDE.
- **Rules and workflows**, which are not aireg kinds: rules in `.agents/rules/*.md` and `~/.gemini/config/rules/*.md` (https://antigravity.google/docs/rules.md); workflows in `.agents/workflows/` and `~/.gemini/config/workflows/` (https://antigravity.google/docs/migration/workflows-to-skills.md).
- **MCP**, also not a kind: `~/.gemini/config/mcp_config.json` and `.agents/mcp_config.json` (https://antigravity.google/docs/cli/gcli-migration.md).
- **A caller variable.** No page names one; `ANTIGRAVITY_AGENT` stays in `src/cli/prompt/caller.ts`.
