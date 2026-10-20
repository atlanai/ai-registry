# Devin evidence

Every path, variable, detection signal, file format and command in `src/harnesses/devin.ts` is a claim, and each has a row here. A claim counts only when one of these settles it:

1. the harness's official documentation: the exact sentence, its URL and the date it was read;
2. the harness's public source, where the documentation is silent: repository, file, line and commit;
3. a real install of the harness: the command run, the harness version and its output.

A claim no source settles is left out of the definition and recorded as undocumented. The definition, its JSON twin in `test/fixtures/harnesses/devin.json` and `devin.test.ts` match this file exactly.

Every page below was read on 2026-10-20, as the Markdown copy the site serves at the URL given. Devin CLI is not published as source, so where the documentation is silent the install settles a claim. Install output comes from Devin CLI 3000.11.3 run with `HOME` set to a sandbox folder (`<sandbox>` below), no credentials in its environment, and no account.

## Versions tested

| Program | Version | Released | Installed with |
|---|---|---|---|
| Devin CLI (`devin`) | 3000.11.3 | 2026-10-07 (`npm view devin time` gives `2026-10-07T23:29:01.723Z`) | `npm install --prefix <prefix> --ignore-scripts devin@3000.11.3`, the package https://docs.devin.ai/cli names in its `homepage`; the platform binary comes from its `devin-linux-x64` optional dependency. `devin --version` printed `devin 3000.11.3 (9c803229faa4)`. |

## Claims

| Claim | Source | Quote or output | Version | Result |
|---|---|---|---|---|
| Project root `.devin` | https://docs.devin.ai/cli/reference/configuration/global-vs-local.md | "Project config (`.devin/`) is loaded from the project root." | docs | confirmed |
| User root `~/.config/devin` | https://docs.devin.ai/cli/reference/configuration/global-vs-local.md | "User (`~/.config/devin/config.json`; `%APPDATA%\devin\config.json` on Windows)" | docs | confirmed |
| `XDG_CONFIG_HOME` names the folder that holds the user root (`within: "devin"`) | `devin skills list --json` with `XDG_CONFIG_HOME=<sandbox>/xdg`, a skill in `<sandbox>/xdg/devin/skills/xdg-root` and one in `<sandbox>/.config/devin/skills/default-root` | Listed `xdg-root` at `<sandbox>/xdg/devin/skills/xdg-root` and not `default-root`. The docs do not name the variable. | 3000.11.3 | confirmed |
| Program `devin` | https://docs.devin.ai/cli (npm `homepage`); the install | `"bin": { "devin": "bin/devin.js" }` in the package; `devin --version` ran. | 3000.11.3 | confirmed |
| Program `devin-desktop` | https://docs.devin.ai/desktop/devin-desktop-faq.md | "The `surf` shell command has been replaced by the `devin-desktop` command." | docs | confirmed |
| Folder `~/.codeium/windsurf` means Devin Desktop is installed | https://docs.devin.ai/desktop/devin-desktop-faq.md | "The legacy `surf` (and `windsurf`) commands still ship in `~/.codeium/windsurf/bin/` for backward compatibility." and "The `~/.codeium/` directory structure is not changing in this release." | docs | confirmed |
| A caller variable Devin sets for its tools | the docs (CLI reference, hooks, configuration) | No page names one; a session needs an account, so no run could show one. | docs | undocumented: no `detect.caller` |
| A skill is `skills/<name>/SKILL.md` | https://docs.devin.ai/cli/extensibility/skills/overview.md | "`.devin/skills/<name>/SKILL.md` \| Project-specific" and "Both locations use the same `SKILL.md` format." | docs | confirmed |
| Reads skills from `.agents` too, in a project and the home folder | https://docs.devin.ai/cli/extensibility/skills/overview.md | "`.agents/skills/<name>/SKILL.md` \| Project-specific" and "`~/.agents/skills/<name>/SKILL.md` \| Global (all projects)" | docs | confirmed |
| Reads skills from `.claude` too, in a project and the home folder | `devin skills list --json` with `<project>/.claude/skills/proj-claude` and `<sandbox>/.claude/skills/home-claude-skill` | Listed `proj-claude` at `<project>/.claude/skills/proj-claude` and `home-claude-skill`. The skills page does not mention `.claude`. | 3000.11.3 | confirmed |
| A linked skill folder loads | `devin skills list --json` with `.devin/skills/linked` a link to a folder outside it | Listed `linked` at `<project>/.devin/skills/linked`. | 3000.11.3 | confirmed |
| Skills list without signing in | `devin skills list --json`, no account | Exit 0, a JSON list with each skill's `base_dir`. | 3000.11.3 | confirmed: L2 probe |
| Agent at `agents/<name>.md` under `.devin/agents/` and `~/.config/devin/agents/` | https://docs.devin.ai/cli/subagents.md | "**Flat file** — `agents/<name>.md` (the same convention used by Claude Code, Cursor, and other tools)." The project tab names `.devin/agents/`, the global tab `~/.config/devin/agents/`. | docs | confirmed |
| Reads agents from `.agents/agents` too, in a project and the home folder | https://docs.devin.ai/cli/subagents.md; `devin doctor --json` with `<project>/.agents/agents/proj-agents-agent.md` and `<sandbox>/.agents/agents/home-agents-agent.md` | The project tab says "Also supported:" `.agents/agents/`. Output: `profile(s) loaded:` listing both. | 3000.11.3 | confirmed |
| Does not read `.claude/agents` | `devin doctor --json` with `<project>/.claude/agents/proj-claude-agent.md` | Not among the `profile(s) loaded`. | 3000.11.3 | confirmed |
| A linked agent file loads | `devin doctor --json` with `.devin/agents/linked-agent.md` a link to a file outside it | `linked-agent` among the `profile(s) loaded`. | 3000.11.3 | confirmed: agents are linked |
| An unknown front-matter key does not stop an agent loading | `devin doctor --json` with agents setting `color: cyan` | Each loaded. | 3000.11.3 | confirmed: no codec |
| The front-matter keys that limit an agent | https://docs.devin.ai/cli/subagents.md | "`allowed-tools` … Restrict which tools the subagent can use. … The alias `tools` is also accepted." | docs | confirmed: kept as written |
| Agents list without signing in | `devin doctor --json`, no account | Exit 0; a check reads `5 profile(s) loaded: dir-agent, linked-agent, proj-agents-agent, proj-devin-agent, user-agent`. | 3000.11.3 | confirmed: L2 probe |
| Plugins load only through `devin plugins install` | `devin plugins list`, no account | `Error: You must be logged in to manage plugins. Run \`devin auth login\` first.` | 3000.11.3 | confirmed: `plugin: { shape: "contents" }` |
| A trust step before project skills or agents load | https://docs.devin.ai/cli/reference/permissions.md; `devin skills list` in a new, untrusted project | The permissions page names no workspace trust; project skills listed with no prompt. | 3000.11.3 | confirmed: no `trust` entry |
| A plugin's command is a skill only a person invokes | `aireg add <plugin folder> --all --for devin`, the plugin holding `commands/deploy.md`, then `devin skills list --json` from the project | `toolkit-deploy` with `"triggers": ["user"]`, where `lint` has `["user", "model"]` | 3000.11.3 | confirmed |

## L2 probes

`devin skills list --json` from the project lists `lint` at `<project>/.agents/skills/lint`; from the home folder it lists `lint` and `ship` at `~/.agents/skills`. `devin doctor --json` lists `reviewer` from the project, and `planner` and `reviewer` from the home folder, among the profiles it loaded.

## Left out

- **A plugin of Devin's own:** it loads only through `devin plugins install`, which needs a sign-in, so a plugin lands as its skills and agents.
- **A caller variable:** undocumented.
- **`reload`:** the docs say nothing about when Devin picks up a change.
