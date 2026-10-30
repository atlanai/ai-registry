# Pi evidence

Every path, variable, detection signal, file format and command in `src/targets/pi.ts` is a claim, and each has a row here. A claim counts only when one of these settles it:

1. the target's official documentation: the exact sentence, its URL and the date it was read;
2. the target's public source, where the documentation is silent: repository, file, line and commit;
3. a real install of the target: the command run, the target version and its output.

A claim no source settles is left out of the definition and recorded as undocumented. The definition, its JSON twin in `test/fixtures/targets/pi.json` and `pi.test.ts` match this file exactly.

Every page below was read on 2026-10-30. Pi's documentation is the Markdown under `packages/coding-agent/docs/` in https://github.com/earendil-works/pi, which https://pi.dev/docs/latest serves; doc and source lines are at tag `v1.4.0`, commit `4a080252f06caf63a525d7873c5d94d3c23887e0` ("Release v1.4.0", 2026-10-22), and every path below is under `packages/coding-agent/`. Install rows come from Pi 1.4.0 and 1.1.0, run with `HOME` in a sandbox folder (`<sandbox>` below), `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` and no sign-in.

## Versions tested

| Program | Version | Released | Installed with |
|---|---|---|---|
| Pi (`pi`) | 1.4.0 | 2026-10-21 (`https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent` `time` gives `2026-10-21T22:48:58.431Z`; `dist-tags.latest` is `1.4.0` on 2026-10-30) | `npm install --prefix <scratch> --ignore-scripts @earendil-works/pi-coding-agent@1.4.0`, the command `README.md` gives without `-g`; `pi --version` printed `1.4.0` |
| Pi (`pi`) | 1.1.0 | 2026-10-07 (`time` gives `2026-10-07T22:16:26.802Z`) | An existing install; `pi --version` printed `1.1.0` |

## Claims

| Claim | Source | Quote or output | Version | Result |
|---|---|---|---|---|
| Product name Pi, program `pi` | https://pi.dev/; `README.md:19`; `package.json:9-11` | The site: "Pi is a minimal, extensible agent harness." The package's `bin` is `{"pi": "dist/bundle/cli.js"}`, and the README starts it with `pi` in a project folder. | docs, 1.4.0 | confirmed |
| Project root `.pi` | `docs/security.md:41`; `package.json:6-8`; `src/core/package-manager.ts:945` | "`.pi/extensions`, `.pi/skills`, `.pi/prompts`, or `.pi/themes`". The source sets `"piConfig": {"configDir": ".pi"}` and `const projectBaseDir = join(this.cwd, CONFIG_DIR_NAME);`. | docs, 1.4.0 | confirmed |
| User root `~/.pi/agent` | `docs/environment-variables.md:81`; `src/config.ts:605-611` | "`PI_CODING_AGENT_DIR` \| Override the config directory; default is `~/.pi/agent`". `getAgentDir()` returns `join(homedir(), CONFIG_DIR_NAME, "agent")` when the variable is unset. | docs, 1.4.0 | confirmed |
| `PI_CODING_AGENT_DIR` names the user root itself (no `within`) | `docs/environment-variables.md:81`; `src/config.ts:585`, `:606-609` | `ENV_AGENT_DIR = \`${APP_NAME.toUpperCase()}_CODING_AGENT_DIR\``; `if (envDir) { return expandTildePath(envDir); }` | docs, 1.4.0 | confirmed |
| `PI_CODING_AGENT_DIR` does not move the user `.agents` folder | `src/core/package-manager.ts:233-235`, `:2464` | `function getHomeDir(): string { return process.env.HOME \|\| homedir(); }` and `const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");` | 1.4.0 | confirmed: the shared `~/.agents/skills` stays visible when the variable moves |
| Detected by `PI_CODING_AGENT_DIR` | the rows above | A variable only Pi reads. | docs | confirmed |
| Detected by program `pi` | the first row | No other coding agent installs a program named `pi`. The name is short, so another tool could share it. | docs | confirmed, with that caveat |
| Caller `PI_CODING_AGENT` | `docs/environment-variables.md:15-16`; `src/cli/setup.ts:6-7`; `src/rpc-entry.ts:7-8` | "`AI_AGENT=pi` is a generic marker that lets tooling identify Pi as the agent that launched the process." and "`PI_CODING_AGENT=true` is Pi-specific and lets child processes detect that they run inside Pi." aireg also reads `AI_AGENT` first, so either one marks Pi. | docs, 1.4.0 | confirmed |
| Skills from `.pi/skills` in the current folder only | `docs/skills.md:59`; `src/core/package-manager.ts:945`, `:2494-2501` | "Place the skill in your user or project skills directory." The project folder is `join(this.cwd, ".pi")` alone, with no walk to parent folders. | docs, 1.4.0 | confirmed |
| Skills from project `.agents/skills`, from the current folder up to the repository root | `docs/skills.md:61`; `src/core/package-manager.ts:474-490`, `:2504-2518` | "Pi also supports the Agent Skills locations `~/.agents/skills/` and `.agents/skills/`. Project `.agents/skills/` directories are discovered from the working directory through its ancestors, stopping at the repository root when one exists." | docs, 1.4.0 | confirmed: aireg places skills here, since Pi finds them from any folder in the project |
| Skills from `~/.pi/agent/skills` (`$PI_CODING_AGENT_DIR/skills`) and `~/.agents/skills` | `docs/skills.md:61`; `src/core/package-manager.ts:2546-2566` | "// User skills from ~/.pi/agent/" then "// User skills from ~/.agents/ (with its own baseDir)". | docs, 1.4.0 | confirmed |
| A skill is `<skills>/<name>/SKILL.md`, found at any depth | `docs/skills.md:59`; `src/core/package-manager.ts:377-454` | "Directories containing `SKILL.md` are discovered recursively." The walk returns a folder's `SKILL.md` and stops there, else recurses into each subfolder except dot folders and `node_modules`. | docs, 1.4.0 | confirmed |
| A linked skill folder loads | `src/core/package-manager.ts:400-403`, `:423-428`; the L2 probe | Each `entry.isSymbolicLink()` is resolved with `statSync(fullPath)` and kept when it is a folder or file. The probe lists `lint` and `ship`, links aireg placed. | 1.1.0, 1.4.0 | confirmed |
| One skill reached through two folders loads once | `src/core/skills.ts:426-437` | "Resolve symlinks to detect duplicate files" and "Skip silently if we've already loaded this exact file (via symlink)". | 1.4.0 | confirmed |
| Same name in two folders: the first found wins, with a warning | `docs/skills.md:85`; `src/core/skills.ts:438-451` | "Name collisions keep the first discovered skill and produce a warning." The order is project `.pi`, project `.agents`, user `.pi`, user `.agents` (`src/core/package-manager.ts:2494-2566`). | docs, 1.4.0 | confirmed |
| Project skills, in `.pi/skills` and `.agents/skills`, load only in a trusted project | `docs/security.md:37-45`, `:59-82`; `src/core/package-manager.ts:2465-2468`, `:2484` | "Pi requires a project-trust decision when it finds any of these resources from the current working directory: ... `.pi/extensions`, `.pi/skills`, `.pi/prompts`, or `.pi/themes` ... project `.agents/skills` in the current directory or an ancestor directory". In print, JSON and RPC modes, "`defaultProjectTrust: \"ask\"` or `\"never\"` skips them." Output below: an untrusted RPC run lists only the user copy of `pr-review`. | docs, 1.4.0 | confirmed |
| The trust step is `/trust`, at project scope | `docs/security.md:69-73`; `src/core/slash-commands.ts:36` | "Saved decisions use canonical directory paths and live in: `~/.pi/agent/trust.json`. Use `/trust` to save a decision for future Pi processes." The default `"ask"` also prompts when an interactive session starts. | docs | confirmed: `trust` for `skill` at `project` |
| Skill front matter: the Agent Skills fields, `disable-model-invocation` included; other keys ignored | `docs/skills.md:7`, `:53`, `:69-81`; `src/core/skills.ts:67-72`, `:341` | "Pi implements the Agent Skills specification. Most invalid fields produce warnings rather than stopping startup." The table names `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools` and `disable-model-invocation`. `SkillFrontmatter` ends `[key: string]: unknown;`. | docs, 1.4.0 | confirmed: no `keys` entry needed |
| No agents | `README.md:19`; https://pi.dev/ | "Pi ships with powerful defaults but skips features like sub-agents and plan mode." | docs | confirmed: no `agent` mapping, so aireg skips agents for Pi |
| Reload: `/reload` reloads skills | `docs/skills.md:89`; `src/core/slash-commands.ts:42` | "Run `/reload` after editing a skill during an active session." and `{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" }` | docs | confirmed |
| Version command `pi --version` | `src/cli/args.ts:94-95`, `:346`; the installs | The help reads "`--version, -v` Show version number". Output: `1.4.0`, and `1.1.0` from the other install. | 1.1.0, 1.4.0 | confirmed |
| RPC `get_commands` lists every skill loaded, with no sign-in | `docs/rpc-commands.md:788-826`; the L2 probe | "Get available commands (extension commands, prompt templates, and skills)." and "`\"skill\"`: Loaded from a skill directory (name is prefixed with `skill:`)". Each entry has `sourceInfo.path` and `sourceInfo.scope`. Pi answers a request written to its input and exits once the input closes. | docs, 1.1.0, 1.4.0 | confirmed: the L2 probe |

Result is `confirmed`, `wrong` (with what is right) or `undocumented`.

## L2 probes

The target's own command that lists what aireg placed, and what it printed. `pi.test.ts` writes `{"type":"get_commands"}` to `pi --mode rpc --no-session --no-extensions` after installing the fixtures in the project and in the user scope, with `PI_CODING_AGENT_DIR` set to `<sandbox>/.pi/agent`. `--no-session` ("Don't save session (ephemeral)") and `--no-extensions` ("Disable extension discovery and built-in extensions", `src/cli/args.ts:314`, `:327`) keep the probe to the skills on disk. Pi 1.4.0 and 1.1.0 passed both. The output below is the same request sent by hand after `aireg add acme/engineering --all --for pi`, in the project and with `-g`, from `examples/acme-registry`, abridged to each skill's name and source:

- From the project, which nothing trusts (`pi --mode rpc`). Only the user copy loads:
  ```json
  {"name": "skill:pr-review", "sourceInfo": {"path": "<sandbox>/home/.agents/skills/pr-review/SKILL.md", "source": "auto", "scope": "user"}}
  ```
- From the project, trusted for the run (`pi --mode rpc --approve`). The project copy loads first and shadows the user copy:
  ```json
  {"name": "skill:pr-review", "sourceInfo": {"path": "<sandbox>/home/project/.agents/skills/pr-review/SKILL.md", "source": "auto", "scope": "project"}}
  ```

The install printed `warning: "engineering/reviewer" was fetched but installed into no target: Pi cannot load agents.`

## Left out

- **`.pi` before `.agents` for skills.** Pi reads both in both scopes, but finds a project's `.pi/skills` only in the folder it starts in, while it finds `.agents/skills` from any folder up to the repository root. Both need the same trust step. So `.agents` comes first, and a skill installed for Pi with Codex, Cursor or OpenCode is written once.
- **`plugin` as a Pi package.** Pi loads packages, which bundle extensions, skills, prompt templates and themes, from npm, git or a local path listed in `settings.json` `packages` (`docs/packages.md`). Extensions are TypeScript that Pi runs in its own process, which a registry plugin never carries, and no package was installed here. A namespace lands as its parts (`shape: "contents"`).
- **Prompt templates.** Pi loads `.pi/prompts/*.md` and `~/.pi/agent/prompts/*.md` as `/name` commands (`docs/prompt-templates.md`), but no registry kind is a prompt template.
- **`claude-code` in `reads`.** Pi does not read `.claude/skills`: no path in its source under `src/` names `.claude` for skills.
- **`AGENTS.md`, `SYSTEM.md` and context files.** Not a kind here.
- **MCP.** Pi has a built-in MCP extension with `.pi/mcp.json` (`docs/mcp.md`). Not a kind here.

## Secondary sources consulted, not relied on

- https://pi.dev/, the product page, which links each topic to the documentation above.
