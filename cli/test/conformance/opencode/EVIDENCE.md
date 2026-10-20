# OpenCode evidence

Every path, variable, detection signal, file format and command in `src/harnesses/opencode.ts` is a claim, and each has a row here. A claim counts only when one of these settles it:

1. the harness's official documentation: the exact sentence, its URL and the date it was read;
2. the harness's public source, where the documentation is silent: repository, file, line and commit;
3. a real install of the harness: the command run, the harness version and its output.

A claim no source settles is left out of the definition and recorded as undocumented. The definition, its JSON twin in `test/fixtures/harnesses/opencode.json` and `opencode.test.ts` match this file exactly.

Every page below was read on 2026-10-20. Source lines are in https://github.com/anomalyco/opencode, the repository whose homepage is https://opencode.ai, at tag `v1.19.0`, commit `733b2c627e5aec39cb33cc22373bdce33053ef2c`, the release tested. Install output comes from OpenCode 1.19.0 run with `HOME` set to a sandbox folder (`<sandbox>` below), `OPENCODE_DISABLE_AUTOUPDATE=1`, no credentials in its environment, and no account.

## Versions tested

| Program | Version | Released | Installed with |
|---|---|---|---|
| OpenCode (`opencode`) | 1.19.0 | 2026-10-11 (`npm view opencode-ai time` gives `2026-10-11T01:38:53.143Z`; 1.19.1 came out on 2026-10-15) | `npm install --prefix <prefix> --ignore-scripts opencode-ai@1.19.0`, then its `postinstall.mjs` run by hand after reading it: it copies the binary from the `opencode-linux-x64` package npm had already installed, and runs it with `--version`. `opencode --version` printed `1.19.0`. |

## Claims

| Claim | Source | Quote or output | Version | Result |
|---|---|---|---|---|
| Project root `.opencode` | https://opencode.ai/docs/config/ | "`.opencode` directories - agents, commands, plugins" and "define agents using markdown files in `~/.config/opencode/agents/` or `.opencode/agents/`" | docs | confirmed |
| User root `~/.config/opencode` | https://opencode.ai/docs/config/ | "Place your global OpenCode config in `~/.config/opencode/opencode.json`." | docs | confirmed |
| `XDG_CONFIG_HOME` names the folder that holds the user root (`within: "opencode"`) | `opencode debug skill` with `XDG_CONFIG_HOME=<sandbox>/xdg`, a skill in `<sandbox>/xdg/opencode/skills/xdg-root` and one in `<sandbox>/.config/opencode/skills/default-root` | Listed `xdg-root` at `<sandbox>/xdg/opencode/skills/xdg-root/SKILL.md` and not `default-root`. The docs do not name the variable. | 1.19.0 | confirmed |
| `OPENCODE_CONFIG_DIR` moves the user root | https://opencode.ai/docs/config/ | "The custom directory is loaded after the global config and `.opencode` directories, so it **can override** their settings." It adds a folder rather than moving one. | docs | wrong: it is a detection signal only |
| Detected by `OPENCODE_CONFIG_DIR` | https://opencode.ai/docs/cli/ | "OPENCODE_CONFIG_DIR \| string \| Path to config directory", a variable only OpenCode reads. | docs | confirmed |
| Program `opencode` | https://opencode.ai/docs/cli/; the install | "`opencode agent list`: List all available agents."; `opencode --version` ran. | 1.19.0 | confirmed |
| Caller `OPENCODE` | `packages/opencode/src/index.ts:75-77` | `process.env.AGENT = "1"`, `process.env.OPENCODE = "1"`, `process.env.OPENCODE_PID = String(process.pid)`, which the tools it runs inherit. The docs are silent. | 1.19.0 | confirmed |
| Caller `OPENCODE_CLIENT` | the docs; `packages/opencode/src/index.ts` | No page names it as set for tools; the variable names the kind of client. | 1.19.0 | wrong: left out |
| A skill is `skills/<name>/SKILL.md` | https://opencode.ai/docs/skills/ | "`.opencode/skills/<name>/SKILL.md`" and "`~/.config/opencode/skills/<name>/SKILL.md`" | docs | confirmed |
| Reads skills from `.agents` and `.claude` too, in a project and the home folder | https://opencode.ai/docs/skills/ | "`.claude/skills/<name>/SKILL.md`", "`~/.claude/skills/<name>/SKILL.md`", "`.agents/skills/<name>/SKILL.md`" and "`~/.agents/skills/<name>/SKILL.md`" | docs | confirmed |
| A linked skill folder loads | `opencode debug skill` with `.opencode/skills/linked` a link to a folder outside it | Listed `linked` at `<sandbox>/p/.opencode/skills/linked/SKILL.md`. | 1.19.0 | confirmed |
| Skills list without signing in | `opencode debug skill`, no account | Exit 0, JSON with each skill's `location`. | 1.19.0 | confirmed: L2 probe |
| A trust step before project skills or agents load | the docs; `opencode debug skill` and `opencode agent list` in a new project | No page names one; both listed the project's skills and agents. | 1.19.0 | confirmed: no `trust` entry |
| Agent at `agents/<name>.md` under each root | https://opencode.ai/docs/agents/ | "Global: `~/.config/opencode/agents/`" and "Per-project: `.opencode/agents/`" | docs | confirmed |
| An agent needs `mode: subagent` | https://opencode.ai/docs/agents/; `opencode agent list` | "If no `mode` is specified, it defaults to `all`." Output: `proj-oc-agent (all)`. | 1.19.0 | wrong: no `mode` is set |
| Does not read agents from `.claude/agents` or `.agents/agents` | `opencode agent list` with an agent in each | Neither listed. | 1.19.0 | confirmed |
| A linked agent file loads | `opencode agent list` with `.opencode/agents/linked-agent.md` a link to a file outside it | `linked-agent (all)` | 1.19.0 | confirmed |
| A front-matter value of the wrong type makes the whole configuration invalid | `opencode agent list` with an agent setting `tools: Read, Grep`, and one setting `color: cyan` | Exit 1: `Error: Configuration is invalid at <sandbox>/p/.opencode/agents/tools-string.md` / `↳ Expected object \| undefined, got "Read, Grep" tools`, and for the other `↳ Expected a string matching the RegExp ^#[0-9a-fA-F]{6}$, got "cyan" color` | 1.19.0 | confirmed: agents keep only `description` (`frontmatter-strict`); one setting `tools` or another key that limits it is refused, not widened |
| `description` is required | https://opencode.ai/docs/agents/ | "This is a **required** config option." | docs | confirmed: kept |
| `name` renames the agent | `opencode agent list` with `name-key.md` setting `name: other-name` | Not listed as `name-key`. | 1.19.0 | confirmed: dropped, so the file's name is the agent's |
| Agents list without signing in | `opencode agent list`, no account | Exit 0, one `<name> (<mode>)` line per agent. | 1.19.0 | confirmed: L2 probe |
| Its plugins are code | https://opencode.ai/docs/plugins/ | "A plugin is a JavaScript/TypeScript module that exports one or more plugin functions." and "Files in these directories are automatically loaded at startup." | docs | confirmed: `plugin: { shape: "contents" }` |
| `OPENCODE_DISABLE_AUTOUPDATE` stops it updating itself | https://opencode.ai/docs/cli/ | "OPENCODE_DISABLE_AUTOUPDATE \| boolean \| Disable automatic update checks" | docs | confirmed: set for the probes |
| Without `keys`, a plugin's command loads as a skill like any other | `aireg add <plugin folder> --all --for opencode`, the plugin holding `commands/deploy.md`, then `opencode debug skill` from the project | `toolkit-deploy` at `<sandbox>/project/.agents/skills/toolkit-deploy/SKILL.md` | 1.19.0 | confirmed |
| `disable-model-invocation` keeps the model from running that skill on its own | https://opencode.ai/docs/skills/, read 2026-10-20; the source at `v1.19.0` | The page names no such key, and no file of the source holds the string `disable-model-invocation` With the key set to `false`, `aireg add <plugin folder> --all` printed `warning: Did not install toolkit-deploy for .agents: it sets disable-model-invocation, which OpenCode cannot read.`; `opencode debug skill` lists `ship` and `lint`, not `toolkit-deploy` | 1.19.0 | wrong: `keys` sets it to `false`, so a skill that sets it is left out |

## L2 probes

`opencode debug skill` from the project lists `lint`, at `<project>/.agents/skills/lint/SKILL.md` or, since a skill of one name loads once, at the user scope's copy; from the home folder it lists `lint` and `ship` at `~/.agents/skills`. `opencode agent list` lists `reviewer (all)` from the project, and `planner (all)` and `reviewer (all)` from the home folder.

## Left out

- **A plugin of OpenCode's own:** its plugins are code, so a plugin lands as its skills and agents.
- **Agent keys beyond `description`:** a value OpenCode reads differently from the harness the agent was written for stops OpenCode loading any configuration.
- **`reload`:** the docs say nothing about when OpenCode picks up a change.
