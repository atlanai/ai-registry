# Muse Code evidence

Every path, variable, detection signal, file format and command in `src/harnesses/muse.ts` is a claim, and each has a row here. A claim counts only when one of these settles it:

1. the harness's official documentation: the exact sentence, its URL and the date it was read;
2. the harness's public source, where the documentation is silent: repository, file, line and commit;
3. a real install of the harness: the command run, the harness version and its output.

A claim no source settles is left out of the definition and recorded as undocumented. The definition, its JSON twin in `test/fixtures/harnesses/muse.json` and `muse.test.ts` match this file exactly.

Every page below was read on 2026-10-20. The Muse Code CLI is not published as source. It was not installed: see Versions tested. So every row rests on the documentation, and the branch proves its placements at L1 alone.

## Versions tested

| Program | Version | Released | Installed with |
|---|---|---|---|
| Muse Code (`muse`) | none | | Not installed. The official installer, `https://dev.meta.ai/install.sh`, downloads a launcher (`https://api.meta.ai/muse-launcher.sh`) that installs whatever its channel serves: `https://api.meta.ai/muse-code/channels/muse-stable` answered `"version":"1.4.11-R6667.1"` on 2026-10-20, and the launcher takes no version to pin. The changelog, https://dev.meta.ai/docs/muse-code/changelog, lists 1.4.2 to 1.4.10 with no dates or build numbers, so no release at least 7 days old could be named. |

## Claims

| Claim | Source | Quote or output | Version | Result |
|---|---|---|---|---|
| Program `muse` | https://dev.meta.ai/docs/muse-code/configuration | The page runs it as `muse init` and `muse exec`. | docs | confirmed |
| User root `~/.config/muse` | https://dev.meta.ai/docs/muse-code/configuration | "User settings live at `~/.config/muse/settings.json`." | docs | confirmed |
| `XDG_CONFIG_HOME` names the folder that holds the user root (`within: "muse"`) | https://dev.meta.ai/docs/muse-code/extending | "**User**: your account-wide skills in `$XDG_CONFIG_HOME/muse/skills` and `~/.agents/skills`, available in every project." | docs | confirmed |
| Project root `.muse` | https://dev.meta.ai/docs/muse-code/extending | "**Project**: committed to the repo at `<project-root>/.muse/hooks.json`." | docs | confirmed |
| A skill is `skills/<id>/SKILL.md` | https://dev.meta.ai/docs/muse-code/extending | "**Project**: skills committed to a repo under `<repo>/.agents/skills/<skill-id>/SKILL.md`, shared with anyone who clones it." | docs | confirmed |
| Reads skills from its own folder only in your user scope | https://dev.meta.ai/docs/muse-code/extending | The user line above names `$XDG_CONFIG_HOME/muse/skills`; the project line names `.agents/skills` and "Muse Code also scans repo-local `.codex/skills` and `.claude/skills`." | docs | confirmed: `skill` mapped with `scope: "user"` |
| Reads skills from `.agents`, `.claude` and `.codex` too | https://dev.meta.ai/docs/muse-code/extending | The two lines above, and "Muse Code also discovers `~/.claude/skills` and `$CODEX_HOME/skills` by default, falling back to `~/.codex/skills` when `CODEX_HOME` is unset." | docs | confirmed |
| Project skills load only in a trusted workspace | https://dev.meta.ai/docs/muse-code/permissions | "The first time you open a workspace, Muse Code asks whether to trust it." and "When you trust a workspace, Muse Code loads its project-local skills, rules, and hooks." | docs | confirmed: no command trusts a workspace alone, so the docs say it instead of a `trust` entry |
| A linked skill folder loads | the docs | No page says. | | undocumented: skills are linked, as for every harness; not proven |
| Agent folder and format | https://dev.meta.ai/docs/muse-code/extending | "A **subagent** is a child agent that the lead spawns for one bounded task." No page gives a folder or file format for one a person defines. | docs | undocumented: agents left out |
| Plugin folder and manifest | https://dev.meta.ai/docs/muse-code/extending | "**Plugin**: skills contributed by enabled plugin bundles." No page gives a folder or manifest. | docs | undocumented: `plugin: { shape: "contents" }` |
| Caller `MUSE_SESSION_ID` | https://dev.meta.ai/docs/muse-code/extending | "Muse Code passes `MUSE_SESSION_ID` to `stdio` servers." That names MCP servers, not the commands it runs. | docs | undocumented for a command it runs: left out |

## L2 probes

None: the CLI was not installed.

## Left out

- **Agents:** no folder or format is documented.
- **A plugin of Muse Code's own:** no folder or manifest is documented, so a plugin lands as its skills.
- **Plugin commands:** this registry model has no command kind.
- **A caller variable:** none is documented for the commands it runs.
- **`verified`:** no version was tested.
