# Hermes Agent evidence

Every path, variable, detection signal, file format and command in `src/harnesses/hermes.ts` is a claim, and each has a row here. A claim counts only when one of these settles it:

1. the harness's official documentation: the exact sentence, its URL and the date it was read;
2. the harness's public source, where the documentation is silent: repository, file, line and commit;
3. a real install of the harness: the command run, the harness version and its output.

A claim no source settles is left out of the definition and recorded as undocumented. The definition, its JSON twin in `test/fixtures/harnesses/hermes.json` and `hermes.test.ts` match this file exactly.

Every page below was read on 2026-10-20, under https://hermes-agent.nousresearch.com/docs/. Source is https://github.com/NousResearch/hermes-agent at tag `v0.21.6`, commit `818c13be1dc4fd28987e1e881a9408224afd4535`, the release tested. Install output comes from Hermes Agent v0.21.6 run with `HOME` set to a sandbox folder (`<sandbox>` below), no credentials in its environment, and no account.

## Versions tested

| Program | Version | Released | Installed with |
|---|---|---|---|
| Hermes Agent (`hermes`) | 0.21.6 | 2026-10-08 (the GitHub release `v0.21.6` was published `2026-10-08T11:51:57Z`) | The official installer installs a git checkout; its steps beyond that also write install receipts and shell profile lines, so the checkout was made directly: `git clone --depth 1 --branch v0.21.6` of the repository, then `uv sync --frozen --no-dev --python 3.14`, which installs the dependencies its `uv.lock` pins (the lock supports Python 3.14 alone, which uv provided). `hermes --version` printed `Hermes Agent v0.21.6 (2026.9.24) · upstream 818c13be`. |

## Claims

| Claim | Source | Quote or output | Version | Result |
|---|---|---|---|---|
| A personal agent | `pyproject.toml:8` | `description = "The self-improving AI agent — creates skills from experience, improves them during use, and runs anywhere"` | 0.21.6 | confirmed: `kind: "personal"` |
| User root `~/.hermes` | `user-guide/features/skills` | "All skills live in `~/.hermes/skills/` — the primary directory and source of truth." | docs | confirmed |
| `HERMES_HOME` moves the user root | `reference/environment-variables`; `hermes skills list` with `HERMES_HOME=<sandbox>/hh` | "Select the configuration and user-data home." and "Defaults to `~/.hermes` on POSIX". Output listed a skill placed in `<sandbox>/hh/skills`. | 0.21.6 | confirmed; also a detection signal |
| Program `hermes` | `pyproject.toml:558` | `hermes = "hermes_cli.main:main"`; `hermes --version` ran. | 0.21.6 | confirmed |
| Caller `HERMES_SESSION_ID` | `reference/environment-variables` | "**Exported automatically into every tool subprocess** Hermes spawns (`terminal`, `execute_code`, persistent shell, Docker/Singularity backends, delegated subagent runs)." | docs | confirmed |
| Profiles at `~/.hermes/profiles/<name>` | `user-guide/profiles`; `hermes -p work skills list` | Each profile is "a separate Hermes home directory", recognized "under `~/.hermes/profiles/`", and "The default profile is simply `~/.hermes` itself." Output, after `hermes profile create work`, listed a skill placed in `~/.hermes/profiles/work/skills`. | 0.21.6 | confirmed: `instances: { root: "~/.hermes/profiles/{profile}" }` |
| Project root `.hermes` | `user-guide/features/skills` | The project tier: "`<project-root>/.hermes/skills/`" | docs | confirmed |
| A skill is `skills/<name>/SKILL.md` | `user-guide/features/skills`; `hermes skills list` | The folders above; a folder holding `SKILL.md` with `name` and `description` listed as `local`. | 0.21.6 | confirmed |
| Project skills load only once the project is trusted | `user-guide/features/skills`; `hermes skills list` in an untrusted project | Run "`hermes skills trust`" to trust the current repo, stored in "`skills.trusted_project_dirs`". Output listed no skill from the untrusted project's `.hermes/skills`. | 0.21.6 | confirmed: `trust: { skill: { run: "hermes skills trust", scope: "project" } }`, printed, never run |
| Reads `.agents/skills` | `user-guide/features/skills`; `hermes skills list` with `~/.agents/skills/agents-home` | The project tier also names "`<project-root>/.agents/skills/`", but `~/.agents/skills` was not listed. | 0.21.6 | confirmed for a project alone, so no `reads`: each skill goes to its own folder |
| It edits skills, in any folder | `user-guide/features/skills` | "The agent can modify or delete any skill." and "Existing skills are modified where they are found, including skills under `external_dirs`," and "External dirs are not a write-protection boundary" | docs | confirmed: skills are copies (`place: "copy"`), so an edit shows in `aireg status` and is never overwritten |
| `skills.external_dirs` adds folders | `user-guide/features/skills`; `hermes skills list` with a folder in `external_dirs` | Configure them by adding "`external_dirs` under the `skills` section in `~/.hermes/config.yaml`". Output listed its skill as `external`. | 0.21.6 | confirmed, not used: see Left out |
| A linked skill folder loads | `hermes skills list` with `~/.hermes/skills/linked` a link to a folder outside it | Listed `linked` as `local`. | 0.21.6 | confirmed, though skills are copied (above) |
| Skills list without signing in | `hermes skills list`, no account | Exit 0, a table of each skill's name, source and status. | 0.21.6 | confirmed: L2 probe |
| Agents a person defines | the docs | No page names a folder for them. | docs | undocumented: agents left out |
| The user root on Windows | `reference/environment-variables` | "`%LOCALAPPDATA%\hermes` on Windows" | docs | wrong for Windows: the user root under `~/` is right on POSIX alone, and the contract has no root per platform |
| A plugin's command loads as a skill | `aireg add <plugin folder> --all --for hermes`, the plugin holding `commands/deploy.md`, then `hermes skills list` | `toolkit-deploy` listed `local`, `enabled` | 0.21.6 | confirmed |
| `disable-model-invocation` keeps the model from running that skill on its own | `user-guide/features/skills`; the source at `v0.21.6` | The page names no such key, and the source holds the string only in a test, as text a skill must not contain | 0.21.6 | wrong: see Left out |

## L2 probes

`hermes skills list` from the home folder lists `lint` and `ship` as `local`. With `-p work`, it lists the skill placed for `hermes:work` in `~/.hermes/profiles/work/skills`.

## Left out

- **A folder of aireg's own in `skills.external_dirs`:** Hermes edits skills there just as in `~/.hermes/skills`, so it would protect nothing, and it would need a config edit and a folder named for aireg. Skills are copied into `skills/`, the folder its docs call the source of truth.
- **Agents:** no folder for agents a person defines is documented.
- **A plugin of its own:** a plugin lands as its skills.
- **Keeping a plugin's command from running on its own:** aireg writes the command as a skill holding `disable-model-invocation: true`, which Hermes Agent does not read, so the model may run it unasked.
- **Its own lock and its persona and memory files:** aireg never writes them.
- **Windows:** Hermes keeps its home in `%LOCALAPPDATA%\hermes` there.
- **`reload`:** the docs say nothing about when it picks up a change.
