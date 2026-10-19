# Codex evidence

Every path, variable, detection signal, file format and command in `src/harnesses/codex.ts` is a claim, and each has a row here. A claim counts only when one of these settles it:

1. the harness's official documentation: the exact sentence, its URL and the date it was read;
2. the harness's public source, where the documentation is silent: repository, file, line and commit;
3. a real install of the harness: the command run, the harness version and its output.

A claim no source settles is left out of the definition and recorded as undocumented. The definition, its JSON twin in `test/fixtures/harnesses/codex.json` and `codex.test.ts` match this file exactly.

## Versions tested

| Program | Version | Released | Installed with |
|---|---|---|---|
| `codex` (npm `@openai/codex`, with `@openai/codex@0.162.1-linux-x64`) | 0.162.1 | 2026-10-09 (npm publish time; tag `rust-v0.162.1` at commit `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`) | `npm install --prefix <private prefix> --ignore-scripts @openai/codex@0.162.1`; `codex --version` printed `codex-cli 0.162.1` |

Documentation was read at <https://developers.openai.com/codex> on 2026-10-19. Source lines cite `github.com/openai/codex` at commit `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` (`rust-v0.162.1`). Every run used a sandbox home with `HOME` and `CODEX_HOME` inside it and no account.

## Claims

| Claim | Source | Quote or output | Version | Result |
|---|---|---|---|---|
| The project root is `.codex` | <https://developers.openai.com/codex/config-basic>, read 2026-10-19 | "To scope settings to a specific project or subfolder, add a .codex/config.toml file in your repo." | 0.162.1 | confirmed |
| The user root is `~/.codex` | <https://developers.openai.com/codex/config-advanced>, read 2026-10-19 | "Codex stores its local state under CODEX_HOME (defaults to ~/.codex)." | 0.162.1 | confirmed |
| `CODEX_HOME` moves the user root, and is the variable that says Codex is set up | Same sentence; real install with `CODEX_HOME=<home>/codex-home` | `codex plugin list` printed the plugin at `<home>/codex-home/plugins/cache/kit/kit/local`, and the stub run below offered an agent from `<home>/codex-home/agents` and not one from `<home>/.codex/agents` | 0.162.1 | confirmed |
| The program is `codex` | `openai/codex:README.md:42,50@092d3ac`; `openai/codex:codex-cli/package.json:7@092d3ac` | "npm install -g @openai/codex"; "Then simply run `codex` to get started."; `"codex": "bin/codex.js"` | 0.162.1 | confirmed |
| `codex --version` prints the version | Real install: `codex --version` | `codex-cli 0.162.1` | 0.162.1 | confirmed |
| `CODEX_SANDBOX` is set in commands Codex runs | `openai/codex:codex-rs/core/src/spawn.rs:26@092d3ac`; `codex-rs/core/src/sandboxing/mod.rs:179` | `pub const CODEX_SANDBOX_ENV_VAR: &str = "CODEX_SANDBOX";`, inserted into a command's environment when it runs under the macOS sandbox | 0.162.1 | confirmed |
| `CODEX_CI` is set in commands Codex runs | `openai/codex:codex-rs/core/src/unified_exec/process_manager.rs:103@092d3ac` | `("CODEX_CI", "1"),` in the environment of every command it runs | 0.162.1 | confirmed |
| `CODEX_THREAD_ID` is set in commands Codex runs | `openai/codex:codex-rs/protocol/src/shell_environment.rs:7,153@092d3ac` | `pub const CODEX_THREAD_ID_ENV_VAR: &str = "CODEX_THREAD_ID";`; `env_map.insert(CODEX_THREAD_ID_ENV_VAR.to_string(), thread_id.to_string());` | 0.162.1 | confirmed |
| Outside a plugin, a project's skills are read from `.agents/skills` | <https://developers.openai.com/codex/skills>, read 2026-10-19; L2 | "For repositories, Codex scans .agents/skills in every directory from your current working directory up to the repository root." `codex debug prompt-input` in the project listed `- lint: Lints a change.` under the root `<home>/project/.agents/skills` | 0.162.1 | confirmed |
| Your user skills are read from `~/.agents/skills`, under `HOME`, not `CODEX_HOME` | <https://developers.openai.com/codex/skills>, read 2026-10-19; `openai/codex:codex-rs/ext/skills/src/host_roots.rs:105@092d3ac`; L2 | "$HOME/.agents/skills" (scope USER); `home_dir.join(AGENTS_DIR_NAME).join(SKILLS_DIR_NAME)`; `codex debug prompt-input` in the home folder listed `- lint: Lints a change.` under `<home>/.agents/skills` | 0.162.1 | confirmed |
| A skill may be a linked folder | <https://developers.openai.com/codex/skills>, read 2026-10-19; L2 | "Codex supports symlinked skill folders and follows the symlink target when scanning these locations." The linked `lint` folder was listed | 0.162.1 | confirmed |
| A project's skills load without a trust step | `openai/codex:codex-rs/tui/src/onboarding/trust_directory.rs:66-67@092d3ac`; L2 | "Config, hooks, and exec policies from untrusted folders stay disabled. Trusted project folders can still contribute settings. Skills still load, ..."; `lint` was listed in a project Codex has never trusted | 0.162.1 | confirmed |
| An agent is a TOML file in `agents/` of either root | <https://developers.openai.com/codex/subagents>, read 2026-10-19 | "To define your own custom agents, add standalone TOML files under ~/.codex/agents/ for personal agents or .codex/agents/ for project-scoped agents." | 0.162.1 | confirmed |
| An agent file holds `name`, `description` and `developer_instructions` | <https://developers.openai.com/codex/subagents>, read 2026-10-19 | "Every standalone custom agent file must define: name description developer_instructions" | 0.162.1 | confirmed |
| Any `.toml` file under `agents/` is read, named by its `name` key, so `agents/<name>.toml` works | `openai/codex:codex-rs/agent-roles/src/discovery.rs:31@092d3ac`; stub run | `.is_some_and(\|extension\| extension == "toml")`; the agents aireg wrote, `planner` and `reviewer`, were offered | 0.162.1 | confirmed |
| Codex refuses to run a linked agent file (the earlier comment) | `openai/codex:codex-rs/exec-server/src/local_file_system.rs:691@092d3ac`; stub run | Directory reads follow a link to its target; a linked `~/.codex/agents/linkeduser.toml` was offered as `linkeduser` | 0.162.1 | wrong: a linked agent file loads. aireg still writes each agent as a file, never a link, because the `frontmatter-toml` codec rewrites it |
| A project's agents load with no trust step (plan) | <https://developers.openai.com/codex/config-basic>, read 2026-10-19; `openai/codex:codex-rs/agent-roles/src/loader.rs:35,78@092d3ac`; `codex-rs/config/src/state.rs:605`; stub run | "For security, Codex loads project .codex/ layers only when you trust the project." Agents come from each enabled config layer's `agents` folder, and a disabled layer is skipped. `projonly` in `<project>/.codex/agents` was not offered in a project Codex has not trusted, while user agents were | 0.162.1 | wrong: a project's agents load only once Codex trusts the project |
| The trust step is running `codex` in the project | <https://developers.openai.com/codex/agent-approvals-security>, read 2026-10-19; `openai/codex:codex-rs/tui/src/onboarding/trust_directory.rs:70@092d3ac` | "Codex may also start in read-only until you explicitly trust the working directory (for example, via an onboarding prompt or /permissions)."; the prompt reads "Trust this folder? Codex can read, edit, and run files here, ..." | 0.162.1 | confirmed |
| A plugin is installed at `~/.codex/plugins/cache/<marketplace>/<plugin>/local` | <https://developers.openai.com/codex/plugins/build>, read 2026-10-19; `openai/codex:codex-rs/core-plugin-common/src/installed.rs:10-11@092d3ac`; L2 | "~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/. For local plugins, $VERSION is local"; `pub const DEFAULT_PLUGIN_VERSION: &str = "local";`, `pub const PLUGINS_CACHE_DIR: &str = "plugins/cache";` (under `CODEX_HOME`); `codex plugin list` printed `kit@kit  installed, enabled  local` | 0.162.1 | confirmed |
| Plugins load from your user installation only | <https://developers.openai.com/codex/plugins/build>, read 2026-10-19 | The cache path above is under `~/.codex`; "The plugin browser saves user-level choices in ~/.codex/config.toml" | 0.162.1 | confirmed |
| The plugin's `local` folder is a real folder, not a link | `openai/codex:codex-rs/core-plugin-common/src/installed.rs:52@092d3ac`; real install | `entry.file_type().ok().filter(std::fs::FileType::is_dir)?;` (the entry's own type, so a link is skipped). With `local` replaced by a link to the same folder, `codex plugin list` printed `kit@kit  not installed` | 0.162.1 | confirmed: placed as a real folder of links (`fan`) |
| The manifest is `.codex-plugin/plugin.json` | <https://developers.openai.com/codex/plugins/build>, read 2026-10-19; `openai/codex:codex-rs/exec-server-protocol/src/protocol.rs:52@092d3ac` | "Existing .codex-plugin/plugin.json files remain supported as a compatibility fallback."; `".codex-plugin/plugin.json",` | 0.162.1 | confirmed |
| The manifest holds `interface.displayName`, `interface.shortDescription` and `skills: "./skills/"` | <https://developers.openai.com/codex/plugins/build>, read 2026-10-19 | "It also declares skills: "./skills/""; the documented `interface` object has `"displayName"` and `"shortDescription"` | 0.162.1 | confirmed |
| A portable root `plugin.json` beside it (the earlier definition) | `openai/codex:codex-rs/utils/plugins/src/plugin_namespace.rs:43@092d3ac`; `codex-rs/core-plugins/src/loader.rs:900`; `codex-rs/ext/skills/src/loader/host.rs:220-222`; real install | A root `plugin.json` with a `$schema` is read first; it makes Codex read the plugin's skills as direct children and drop each that "resolves outside plugin root". With it, `codex debug prompt-input` left out `kit:ship`, whose folder is a link; without it, it listed `- kit:ship: Ships a change.` | 0.162.1 | wrong: the portable root manifest is left out, so a fanned plugin's linked skills load |
| A plugin's linked `skills` folder loads under `.codex-plugin/plugin.json` | L2 | `codex debug prompt-input` listed `- kit:ship: Ships a change.` | 0.162.1 | confirmed |
| A plugin loads only once `[plugins."<plugin>@<marketplace>"]` sets `enabled = true` in `config.toml` | <https://developers.openai.com/codex/config-reference>, read 2026-10-19; `openai/codex:codex-rs/core-plugins/src/marketplace_policy.rs:293,301@092d3ac` | "plugins.<plugin>.enabled ... Enable or disable a local-marketplace plugin using a plugin-name@marketplace-name key."; the plugins Codex loads are the keys of `plugins` in the effective config | 0.162.1 | confirmed |
| A local marketplace is `[marketplaces.<name>]` with `source_type = "local"` and an absolute `source` folder holding `.agents/plugins/marketplace.json` | <https://developers.openai.com/codex/config-reference>, read 2026-10-19; L2 | "marketplaces.<name>.source ... Use an absolute path for a local source; the directory contains .agents/plugins/marketplace.json." and "marketplaces.<name>.source_type git \| local"; `codex plugin marketplace list` printed `kit  <home>/codex-home/plugins/cache/kit` | 0.162.1 | confirmed |
| `marketplace.json` names the marketplace and lists each plugin as `{ "name", "source": { "source": "local", "path": "./<plugin>/local" } }` | <https://developers.openai.com/codex/plugins/build>, read 2026-10-19; L2 | "Use top-level name to identify the marketplace."; "Keep source.path relative to the marketplace root, start it with ./, and keep it inside that root." | 0.162.1 | confirmed |
| A marketplace entry may leave out `policy` and `category` | <https://developers.openai.com/codex/plugins/build>, read 2026-10-19; real install | The docs say "Always include policy.installation, policy.authentication, and category on each plugin entry." Without them, `codex plugin list --json` printed `"installPolicy": "AVAILABLE"` and `"authPolicy": "ON_INSTALL"` and the plugin loaded | 0.162.1 | confirmed by the install; the docs ask for them |
| A plugin carries no agents | <https://developers.openai.com/codex/plugins>, read 2026-10-19 | "A plugin can contain one or more of these parts:" skills, MCP servers, browser extensions and hooks. aireg places a plugin's agents in `agents/` as it does any other | 0.162.1 | confirmed |
| Your user `config.toml` loads with no trust step | <https://developers.openai.com/codex/config-basic>, read 2026-10-19 | "User and system config still load, including user/global hooks and rules." | 0.162.1 | confirmed |
| A change shows in a new session | <https://developers.openai.com/codex/plugins>, read 2026-10-19; <https://developers.openai.com/codex/skills> | "Install a plugin from a configured marketplace, then start a new session before using its bundled skills or tools."; "Codex detects skill changes automatically." | 0.162.1 | confirmed; no `reload`, which aireg would print after every change, skills included |
| In a project, a plugin's command loads as a skill | `aireg add <plugin folder> --all --for codex`, the plugin holding `commands/deploy.md`, then `codex debug prompt-input` from the project | `.agents/skills/toolkit-deploy/SKILL.md` is written; the output lists `- toolkit-deploy: Deploys the current branch. (file: r3/toolkit-deploy/SKILL.md)` | 0.162.1 | confirmed |
| Codex reads `agents/openai.yaml`, not `disable-model-invocation`, to keep a skill from running on its own | <https://learn.chatgpt.com/docs/build-skills>, where <https://developers.openai.com/codex/skills> now leads, read 2026-10-20; `aireg add <skills folder> --all --for codex`, its `release` skill setting `disable-model-invocation: true`, then `codex debug prompt-input` | "When `false`, Codex won’t implicitly invoke the skill based on user prompt"; the page names no `disable-model-invocation`. Output: `.agents/skills/release/` is a copy holding `agents/openai.yaml`, and the skills offered list `notes` but not `release` | 0.162.1 | confirmed: `keys` writes `agents/openai.yaml` with `policy: allow_implicit_invocation: false` |

Result is `confirmed`, `wrong` (with what is right) or `undocumented`.

## L2 probes

The harness's own commands that list what aireg placed, and what each printed. `codex.test.ts` runs the first three with `CODEX_HOME=<home>/codex-home`; none needs an account.

- `codex debug prompt-input`, from the project, prints the skills Codex offers the model. The plugin's skill root is where its linked `skills` folder leads:

  ```text
  - `r0` = `<home>/.agents/skills`
  - `r2` = `<home>/.registry/artifacts/kit/kit/skills`
  - `r3` = `<home>/project/.agents/skills`
  - lint: Lints a change. (file: r3/lint/SKILL.md)
  - kit:ship: Ships a change. (file: r2/ship/SKILL.md)
  - lint: Lints a change. (file: r0/lint/SKILL.md)
  ```

- `codex debug prompt-input`, from the home folder, prints the same without the project root and its `lint`.
- `codex plugin list`, from the home folder:

  ```text
  Marketplace `kit`
  <home>/codex-home/plugins/cache/kit/.agents/plugins/marketplace.json

  PLUGIN   STATUS              VERSION  SOURCE
  kit@kit  installed, enabled  local    <home>/codex-home/plugins/cache/kit/kit/local
  ```

- `codex plugin marketplace list`, from the home folder, prints `kit  <home>/codex-home/plugins/cache/kit`.

Codex has no command that lists agents: neither the CLI nor its app server has one, and they reach the model only in the `spawn_agent` tool. To check agents without an account, `codex exec` was pointed at a local stub of the model endpoint, with the provider given only in `-c` options, and the roles in the `spawn_agent` tool of the request it sent were read. After aireg installed into the sandbox, it offered `planner reviewer default explorer worker`. This is not part of `codex.test.ts`, which runs only list commands.

After `aireg remove ns/lint` in each scope, both `codex debug prompt-input` probes listed only `- kit:ship: Ships a change.`, and `codex plugin list` still printed `kit@kit  installed, enabled  local`.

## Left out

- **A plugin in a project.** Codex installs every plugin into the user cache. A project can turn a plugin on in its own `.codex/config.toml` only once Codex trusts the project, with the plugin offered by a marketplace in the repository, so aireg installs plugins in your user scope alone.
- **The portable root `plugin.json`.** Codex reads it ahead of `.codex-plugin/plugin.json` and then skips every linked skill in the plugin.
- **`policy` and `category` in the marketplace entry.** Codex loads the plugin without them, and no value for `category` follows from what aireg installs.
- **`reload`.** Codex needs a new session for a new plugin or agent, but sees skill changes on its own; a harness's `reload` is printed after every change.
- **Agent probes in `codex.test.ts`.** No Codex command lists agents without a model session.
