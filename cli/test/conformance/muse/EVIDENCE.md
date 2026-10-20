# Muse Code evidence

Every path, variable, detection signal, file format and command in `src/harnesses/muse.ts` is a claim, and each has a row here. A claim counts only when one of these settles it:

1. the harness's official documentation: the exact sentence, its URL and the date it was read;
2. the harness's public source, where the documentation is silent: repository, file, line and commit;
3. a real install of the harness: the command run, the harness version and its output.

A claim no source settles is left out of the definition and recorded as undocumented. The definition, its JSON twin in `test/fixtures/harnesses/muse.json` and `muse.test.ts` match this file exactly.

Every page below was read on 2026-10-20. The Muse Code CLI is not published as source, so where the documentation is silent the install settles a claim. Install output comes from Muse Code 1.4.11 run with `HOME` set to a sandbox folder (`<sandbox>` below), no credentials in its environment, and no account.

## Versions tested

| Program | Version | Released | Installed with |
|---|---|---|---|
| Muse Code (`muse`) | 1.4.11 (`1.4.11-R6667.1`) | Less than 7 days before it was tested: the stable channel serves only its newest build. | The official installer, `https://dev.meta.ai/install.sh`, runs a launcher (`https://api.meta.ai/muse-launcher.sh`) that installs whatever its channel serves, with no version to pin: `https://api.meta.ai/muse-code/channels/muse-stable` answered `"version":"1.4.11-R6667.1"` on 2026-10-20, and the changelog, https://dev.meta.ai/docs/muse-code/changelog, gives no dates or build numbers to name an older one. So the binary was fetched as the launcher does, from that version's `manifest.json`, and checked against the SHA-256 the manifest gives (`6fda12a6…d7976839`), without the launcher. `muse --version` printed `Muse Code 1.4.11 (1.4.11-R6667.1)`. This is the one harness tested on a release under 7 days old. |

## Claims

| Claim | Source | Quote or output | Version | Result |
|---|---|---|---|---|
| Program `muse` | https://dev.meta.ai/docs/muse-code/configuration; the install | The page runs it as `muse init` and `muse exec`; `muse --version` ran. | 1.4.11 | confirmed |
| Skills list without signing in | `muse skills list --source user --json`, no account | Exit 0, JSON with each skill's `name` and `path`. | 1.4.11 | confirmed: L2 probe |
| User root `~/.config/muse` | https://dev.meta.ai/docs/muse-code/configuration | "User settings live at `~/.config/muse/settings.json`." | docs | confirmed |
| `XDG_CONFIG_HOME` names the folder that holds the user root (`within: "muse"`) | https://dev.meta.ai/docs/muse-code/extending; `muse skills list --source user --json` with `XDG_CONFIG_HOME=<sandbox>/xdg` | "**User**: your account-wide skills in `$XDG_CONFIG_HOME/muse/skills` and `~/.agents/skills`, available in every project." Output listed a skill in `<sandbox>/xdg/muse/skills` as `$CONFIG_DIR/skills/xdg-muse/SKILL.md`, and not one in `<sandbox>/.config/muse/skills`. | 1.4.11 | confirmed |
| Project root `.muse` | https://dev.meta.ai/docs/muse-code/extending | "**Project**: committed to the repo at `<project-root>/.muse/hooks.json`." | docs | confirmed |
| A skill is `skills/<id>/SKILL.md` | https://dev.meta.ai/docs/muse-code/extending | "**Project**: skills committed to a repo under `<repo>/.agents/skills/<skill-id>/SKILL.md`, shared with anyone who clones it." | docs | confirmed |
| Reads skills from its own folder only in your user scope | https://dev.meta.ai/docs/muse-code/extending | The user line above names `$XDG_CONFIG_HOME/muse/skills`; the project line names `.agents/skills` and "Muse Code also scans repo-local `.codex/skills` and `.claude/skills`." | docs | confirmed: `skill` mapped with `scope: "user"` |
| Reads skills from `.agents`, `.claude` and `.codex` too | https://dev.meta.ai/docs/muse-code/extending; `muse skills list` | The two lines above, and "Muse Code also discovers `~/.claude/skills` and `$CODEX_HOME/skills` by default, falling back to `~/.codex/skills` when `CODEX_HOME` is unset." Output listed skills from `$HOME/.agents/skills`, `$HOME/.claude/skills` and `$CODEX_HOME/skills`. | 1.4.11 | confirmed |
| Project skills load only in a trusted workspace | https://dev.meta.ai/docs/muse-code/permissions; `muse skills list` in a new project | "The first time you open a workspace, Muse Code asks whether to trust it." and "When you trust a workspace, Muse Code loads its project-local skills, rules, and hooks." Output: `project-skills-untrusted: project skills skipped because workspace is untrusted (.agents/skills)` | 1.4.11 | confirmed: no command trusts a workspace alone, so the docs say it instead of a `trust` entry |
| A linked skill folder loads | `muse skills list` with `$XDG_CONFIG_HOME/muse/skills/linked` a link to a folder outside it | Listed `linked` as `$CONFIG_DIR/skills/linked/SKILL.md`. | 1.4.11 | confirmed: skills are linked |
| Agent folder and format | https://dev.meta.ai/docs/muse-code/extending | "A **subagent** is a child agent that the lead spawns for one bounded task." No page gives a folder or file format for one a person defines. | docs | undocumented: agents left out |
| Plugin folder and manifest | https://dev.meta.ai/docs/muse-code/extending; `muse plugins --help` | "**Plugin**: skills contributed by enabled plugin bundles." The CLI installs one with `muse plugins install <path>` "into the cache", and `approve` trusts it; no page names a folder to place one in. | 1.4.11 | undocumented as a folder: `plugin: { shape: "contents" }` |
| Caller `MUSE_SESSION_ID` | https://dev.meta.ai/docs/muse-code/extending | "Muse Code passes `MUSE_SESSION_ID` to `stdio` servers." That names MCP servers, not the commands it runs. | docs | undocumented for a command it runs: left out |
| A plugin's command is a skill only a person invokes | `aireg add <plugin folder> --all --for muse`, the plugin holding `commands/deploy.md`, then `muse skills list` | `toolkit-deploy` listed with activation `user-invocable-only`, where `lint` and `ship` are `on` | 1.4.11 | confirmed |

## L2 probes

`muse skills list --source user --json` from the home folder lists `lint` and `ship` at `$HOME/.agents/skills`. A project's skills load only in a trusted workspace, so they are checked at L1 alone.

## Left out

- **Agents:** no folder or format is documented.
- **A plugin of Muse Code's own:** no folder or manifest is documented, so a plugin lands as its skills.
- **A caller variable:** none is documented for the commands it runs.
