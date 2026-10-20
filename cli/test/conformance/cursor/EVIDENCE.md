# Cursor evidence

Every path, variable, detection signal, file format and command in `src/harnesses/cursor.ts` is a claim, and each has a row here. A claim counts only when one of these settles it:

1. the harness's official documentation: the exact sentence, its URL and the date it was read;
2. the harness's public source, where the documentation is silent: repository, file, line and commit;
3. a real install of the harness: the command run, the harness version and its output.

A claim no source settles is left out of the definition and recorded as undocumented. The definition, its JSON twin in `test/fixtures/harnesses/cursor.json` and `cursor.test.ts` match this file exactly.

Every page below was read on 2026-10-19, as the Markdown copy the site serves at the URL given. Cursor publishes no source for its editor or CLI, so where the documentation is silent the evidence is the installed CLI: its own commands, and its installed files searched with `grep` (`$D` is `~/.local/share/cursor-agent/versions/2026.10.12-d47ca18` in the install's home).

## Versions tested

| Program | Version | Released | Installed with |
|---|---|---|---|
| Cursor CLI (`agent`, also `cursor-agent`) | 2026.10.12-d47ca18 | 2026-10-12 (`Last-Modified: Mon, 12 Oct 2026 22:43:15 GMT` on `https://downloads.cursor.com/lab/2026.10.12-d47ca18/linux/x64/agent-cli-package.tar.gz`) | The official installer, `https://cursor.com/install`, saved to a file and read. It names one version in its download URL, install folder and links (2026.10.18-ea085cb on the day it was read); that string was replaced with 2026.10.12-d47ca18 and the script run with `HOME` set to a sandbox folder. |
| Cursor editor | not installed | | A desktop application, which cannot run here. Its claims rest on the documentation alone. |

## Claims

| Claim | Source | Quote or output | Version | Result |
|---|---|---|---|---|
| Project root `.cursor` | https://cursor.com/docs/skills.md | "Skills are automatically loaded from these locations: … `.cursor/skills/` \| Project-level" | docs | confirmed |
| User root `~/.cursor` | https://cursor.com/docs/skills.md | "`~/.cursor/skills/` \| User-level (global) on the local machine" | docs | confirmed |
| No variable moves the user root | https://cursor.com/docs/cli/reference/configuration.md | "Configure the Agent CLI using the `cli-config.json` file." … "Override with environment variables: **`CURSOR_CONFIG_DIR`**: custom directory path". It moves that file only; no page names a variable that moves `~/.cursor/skills` or `~/.cursor/agents`. | docs | confirmed: `roots.user.env` stays unset |
| Program `cursor` | https://cursor.com/docs/cli/changelog.md; `grep` in `$D/2911.index.js` | "the `cursor` shim no longer errors on shells that treat unset variables as failures." The shim the CLI writes to `~/.local/bin/cursor` runs the `cursor` found on `PATH` and otherwise prints "Error: No Cursor IDE installation found." | 2026.10.12-d47ca18 | confirmed |
| Program `cursor-agent` | `https://cursor.com/install`, read 2026-10-19 | `# Create symlinks to the Cursor Agent executable (primary: agent, legacy: cursor-agent)` then `ln -s …/cursor-agent ~/.local/bin/agent` and `ln -s …/cursor-agent ~/.local/bin/cursor-agent`. After the install, `cursor-agent --version` printed `2026.10.12-d47ca18`. | 2026.10.12-d47ca18 | confirmed |
| Program `agent` | https://cursor.com/docs/cli/installation.md | "After installation, verify that Cursor CLI is working correctly: `agent --version`". It printed `2026.10.12-d47ca18`. | 2026.10.12-d47ca18 | confirmed; the CLI's current name, kept out of `detect.binary` (see Left out) and used as `verified.command` |
| Caller `CURSOR_AGENT` | https://cursor.com/docs/agent/tools/terminal.md; `grep -o 'CURSOR_AGENT:"1"' $D/index.js` | "Use the `CURSOR_AGENT` environment variable in your shell config to detect when Cursor is running". The CLI sets `CURSOR_AGENT:"1"` in the environment of the commands it runs. | 2026.10.12-d47ca18 | confirmed |
| Caller `CURSOR_TRACE_ID` | Every page in https://cursor.com/llms.txt; `grep -l CURSOR_TRACE_ID -r $D --include=*.js \| wc -l` | No page names it; the CLI's files never mention it (`0`). | 2026.10.12-d47ca18 | undocumented: removed |
| Reads skills from `.agents` | https://cursor.com/docs/skills.md | "`.agents/skills/` \| Project-level" and "`~/.agents/skills/` \| User-level (global) on the local machine" | docs | confirmed |
| Reads skills from `.cursor` | https://cursor.com/docs/skills.md | "`.cursor/skills/` \| Project-level" and "`~/.cursor/skills/` \| User-level (global) on the local machine" | docs | confirmed |
| Reads skills from `.claude` | https://cursor.com/docs/skills.md | "For compatibility, Cursor also loads skills from Claude and Codex directories: `.claude/skills/`, `.codex/skills/`, `~/.claude/skills/`, and `~/.codex/skills/`." | docs | confirmed |
| Reads skills from `.codex` | https://cursor.com/docs/skills.md | The same sentence. | docs | confirmed; missing from the plan, added last |
| Skill at `skills/<name>/SKILL.md` | https://cursor.com/docs/skills.md | "Each skill should be a folder containing a `SKILL.md` file" and, for `name`, "Must match the parent folder name." | docs | confirmed |
| A linked skill folder loads | https://cursor.com/docs/cli/changelog.md | "**Skills found through symlinks.** The skills menu follows symlinked directories when discovering skills." | docs | confirmed |
| Agent at `.cursor/agents/<name>.md`, `~/.cursor/agents/<name>.md` | https://cursor.com/docs/subagents.md | "**Project subagents** \| `.cursor/agents/` \| Current project only" … "**User subagents** \| `~/.cursor/agents/` \| All projects for current user" and "Each subagent is a markdown file with YAML frontmatter" | docs | confirmed |
| Reads agents from `.claude` | https://cursor.com/docs/subagents.md | "`.claude/agents/` \| Current project only (Claude compatibility)" and "`~/.claude/agents/` \| All projects for current user (Claude compatibility)" | docs | confirmed |
| Reads agents from `.codex` | https://cursor.com/docs/subagents.md | "`.codex/agents/` \| Current project only (Codex compatibility)", but every subagent "is a markdown file", and aireg writes Codex's agents there as TOML. | docs | confirmed, not added (see Left out) |
| A linked agent file loads | `grep` in `$D/index.js` | The folder walker the CLI reads `.cursor/agents` with keeps a link to a file: `if(e.isSymbolicLink())try{const e=await(0,n.stat)(r);c=e.isDirectory(),l=e.isFile()}` | 2026.10.12-d47ca18 | confirmed |
| Plugin folder `~/.cursor/plugins/local/<plugin>/` | https://cursor.com/docs/plugins.md; `grep` in `$D/index.js` | "Create a folder for your plugin: `~/.cursor/plugins/local/my-plugin`". The CLI reads `(0,B.join)(n,".cursor","plugins","local")`. | 2026.10.12-d47ca18 | confirmed |
| Plugin manifest `.cursor-plugin/plugin.json` | https://cursor.com/docs/plugins.md; https://cursor.com/docs/reference/plugins.md | "Include either a root `plugin.json` … or `.cursor-plugin/plugin.json` for a Cursor Plugin." and "Cursor Plugin manifests only require a `name`." | docs | confirmed |
| A plugin's skills and agents in `skills/` and `agents/` | https://cursor.com/docs/reference/plugins.md | "Skills \| `skills/` \| Each subdirectory containing a `SKILL.md` file" and "Agents \| `agents/` \| All `.md`, `.mdc`, or `.markdown` files" | docs | confirmed |
| A local plugin is a link or a folder of links (`fan`) | https://cursor.com/docs/plugins.md; `grep` in `$D/index.js` | "Symlinks in `~/.cursor/plugins/local` load only when the target resolves to a directory inside that folder. Cursor skips a symlink that points to a plugin repository elsewhere on disk." Inside a plugin, the CLI refuses a path whose real path leaves the plugin folder: `Path escapes plugin directory via symlink`. | 2026.10.12-d47ca18 | wrong: only real files load, so a plugin is copied (`place: "copy"`) |
| A local plugin only in your user scope | https://cursor.com/docs/plugins.md | "Before you publish, put either plugin format in `~/.cursor/plugins/local`" | docs | confirmed |
| No trust step for skills, agents or plugins | https://cursor.com/docs/agent/security.md; https://cursor.com/docs/cli/reference/parameters.md | "Cursor supports workspace trust, but it's disabled by default." The CLI's `--trust` is "Trust the workspace without prompting": a whole session's trust, not a step for a kind. | docs | confirmed: no `trust` |
| Reload after a change | https://cursor.com/docs/skills.md; https://cursor.com/docs/plugins.md | "When Cursor starts, it automatically discovers skills from skill directories" and "Restart Cursor, or run **Developer: Reload Window**." | docs | confirmed |
| A plugin's commands in `commands/` | https://cursor.com/docs/reference/plugins.md, read 2026-10-20 | "Commands \| `commands/` \| All `.md`, `.mdc`, `.markdown`, or `.txt` files" | docs | confirmed: in your user scope a plugin keeps its commands |
| In a project, a plugin's command is a skill only a person invokes | https://cursor.com/docs/skills.md, read 2026-10-20; install | "Set `disable-model-invocation: true` to make a skill behave like a traditional slash command, where it is only included in context when you explicitly type `/skill-name` in chat." `aireg add <plugin folder> --all --for cursor` wrote `.agents/skills/toolkit-deploy/SKILL.md`, holding `disable-model-invocation: true` | docs | confirmed |
| Version command | https://cursor.com/docs/cli/installation.md | "`agent --version`" printed `2026.10.12-d47ca18` | 2026.10.12-d47ca18 | confirmed |

Result is `confirmed`, `wrong` (with what is right) or `undocumented`.

## L2 probes

Not available. No command of the CLI lists skills, agents or plugins without signing in:

- https://cursor.com/docs/cli/reference/parameters.md lists every command; none lists skills, agents or plugins. `/skills` and `/plugins` are slash commands inside a session.
- `agent plugin --help` offers only `marketplace`, and `agent plugin marketplace list` lists marketplaces, not plugins. Without an account it printed `Error: Authentication required. Run 'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN.` and exited 1.
- `agent`, started on a terminal in a sandbox project to reach `/skills`, printed only `Signing in with the browser...` and a sign-in link. Nothing was signed in to.
- `agent acp`, the Agent Client Protocol server, whose sessions report the commands a session offers, answered `initialize` with one auth method, `cursor_login`, and `session/new` with `{"code":-32000,"message":"Authentication required"}`.
- The CLI's other commands, listed by its `--help` and its bundled `index.js`, manage sessions, cloud agents, MCP servers, marketplaces and the account; none reads local skills, agents or plugins.

So `cursor.test.ts` has no probes, and this harness is checked at L1 only.

## Left out

- **`agent` in `detect.binary`.** It is the CLI's current name, but too common a program name to mean Cursor; the installer always adds `cursor-agent` beside it.
- **`.codex` in `reads.agent`.** Cursor reads Markdown subagents from `.codex/agents/`, but aireg writes Codex's agents there as TOML, which Cursor does not read.
- **`CURSOR_TRACE_ID` in `detect.caller`.** Undocumented.
- **A user root variable.** No variable moves `~/.cursor`.
