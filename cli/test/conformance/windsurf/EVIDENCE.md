# Windsurf evidence

Every path, variable, detection signal, file format and command in `src/targets/windsurf.ts` is a claim, and each has a row here. A claim counts only when one of these settles it:

1. the target's official documentation: the exact sentence, its URL and the date it was read;
2. the target's public source, where the documentation is silent: repository, file, line and commit;
3. a real install of the target: the command run, the target version and its output.

A claim no source settles is left out of the definition and recorded as undocumented. The definition, its JSON twin in `test/fixtures/targets/windsurf.json` and `windsurf.test.ts` match this file exactly.

Every page below was read on 2026-11-25 at https://docs.windsurf.com. Windsurf publishes no source for its editor or Cascade agent.

## Versions tested

| Program | Version | Released | Installed with |
|---|---|---|---|
| Windsurf editor | not installed | | A desktop application, which cannot run in headless CI. Its claims rest on official documentation. |

## Claims

| Claim | Source | Quote or output | Version | Result |
|---|---|---|---|---|
| Product name Windsurf | https://docs.windsurf.com/windsurf/getting-started | Windsurf is the agentic IDE built by Codeium with the Cascade AI agent. | docs | confirmed |
| Project root `.windsurf` | https://docs.windsurf.com/windsurf/cascade/skills | Workspace-specific skills are stored inside `.windsurf/skills/<skill-name>/SKILL.md`. | docs | confirmed |
| User root `~/.codeium/windsurf` | https://docs.windsurf.com/windsurf/cascade/skills | Global skills available across all workspaces are stored inside `~/.codeium/windsurf/skills/<skill-name>/SKILL.md`. | docs | confirmed |
| No variable moves the user root | https://docs.windsurf.com/windsurf/cascade/skills | No official Windsurf documentation page names an environment variable that moves `~/.codeium/windsurf`. | docs | undocumented: `roots.user.env` stays unset |
| Program `windsurf` | https://docs.windsurf.com/windsurf/getting-started | Windsurf installs the `windsurf` CLI launcher onto `PATH` (e.g. `windsurf .`). | docs | confirmed |
| Reads skills from `.windsurf` and `.agents` | https://docs.windsurf.com/windsurf/cascade/skills | Windsurf discovers workspace and user skills from `.windsurf/skills/` and `~/.codeium/windsurf/skills/`, and also detects `.agents/skills/` and `~/.agents/skills/`. | docs | confirmed: `windsurf` primary, `universal` secondary |
| A skill is `skills/<name>/SKILL.md` | https://docs.windsurf.com/windsurf/cascade/skills | Each skill lives in its own subdirectory containing a `SKILL.md` file with `name` and `description` YAML frontmatter. | docs | confirmed |
| Plugin lands as contents | https://docs.windsurf.com/windsurf/cascade/skills | Windsurf documents no plugin manifest format, so plugins land as their skill folders (`shape: "contents"`). | docs | confirmed |
| Reload after a change | https://docs.windsurf.com/windsurf/getting-started | Restart Windsurf, or run `Developer: Reload Window` from the command palette. | docs | confirmed |

Result is `confirmed`, `wrong` (with what is right) or `undocumented`.

## L2 probes

Not available. Windsurf is a desktop IDE with no standalone CLI subcommand that lists loaded skills without a session.

## Left out

- **Agents, rules and workflows.** Windsurf uses `AGENTS.md` files, `.windsurf/rules/*.md` (workspace rules) and `~/.codeium/windsurf/memories/global_rules.md` (single global file), plus `.windsurf/workflows/*.md` (slash commands), which are not aireg's `agent` kind (`AGENT.md` subagents).
- **Claude Code compatibility.** Windsurf documents scanning `.claude/skills/` and `~/.claude/skills/` only when Claude Code integration settings are enabled, so `claude-code` is omitted from default `reads`.
- **Environment variables (`WINDSURF_HOME`, terminal caller).** Official Windsurf docs do not define an environment override for `~/.codeium/windsurf` or a terminal caller variable.
