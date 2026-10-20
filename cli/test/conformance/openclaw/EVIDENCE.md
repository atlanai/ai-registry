# OpenClaw evidence

Every path, variable, detection signal, file format and command in `src/harnesses/openclaw.ts` is a claim, and each has a row here. A claim counts only when one of these settles it:

1. the harness's official documentation: the exact sentence, its URL and the date it was read;
2. the harness's public source, where the documentation is silent: repository, file, line and commit;
3. a real install of the harness: the command run, the harness version and its output.

A claim no source settles is left out of the definition and recorded as undocumented. The definition, its JSON twin in `test/fixtures/harnesses/openclaw.json` and `openclaw.test.ts` match this file exactly.

Every page below was read on 2026-10-20. Install output comes from OpenClaw 2026.10.1 run with `HOME` set to a sandbox folder (`<sandbox>` below), no credentials in its environment, and no account.

## Versions tested

| Program | Version | Released | Installed with |
|---|---|---|---|
| OpenClaw (`openclaw`) | 2026.10.1 | 2026-10-10 (`npm view openclaw time` gives `2026-10-10T22:45:05.897Z`) | `npm install --prefix <prefix> --ignore-scripts openclaw@2026.10.1`, the package https://docs.openclaw.ai/install names. Its `postinstall` only prunes files an earlier install left, so it was not run. The package needs Node.js `>=24.16.0 <25 \|\| >=26.1.0`, so it ran on Node.js 24.21.0 from https://nodejs.org/dist/v24.21.0/, checked against that release's `SHASUMS256.txt`. `openclaw --version` printed `OpenClaw 2026.10.1 (e178c39)`. |

## Claims

| Claim | Source | Quote or output | Version | Result |
|---|---|---|---|---|
| A personal agent | https://docs.openclaw.ai/ | "OpenClaw is an open-source AI assistant that runs on your own hardware and meets you in every chat app you already use." | docs | confirmed: `kind: "personal"` |
| User root `~/.openclaw` | https://docs.openclaw.ai/help/environment | "Override the state directory (default `~/.openclaw`)." | docs | confirmed |
| `OPENCLAW_STATE_DIR` moves the user root | https://docs.openclaw.ai/help/environment; `openclaw skills list --json` with `OPENCLAW_STATE_DIR=<sandbox>/state` | "Override the mutable state directory." Output: `managedSkillsDir` `<sandbox>/state/skills`, listing a skill placed there. | 2026.10.1 | confirmed; also a detection signal |
| No folder in a project | https://docs.openclaw.ai/tools/skills | Every skill source is its workspace, its state folder, `~/.agents/skills` or its own install; none is a project folder. | docs | confirmed: `skill` mapped with `scope: "user"`, and the project root, which the contract needs, does not count for detection (`projectRoot: false`) |
| Program `openclaw` | https://docs.openclaw.ai/cli; the install | `openclaw --version` ran. | 2026.10.1 | confirmed |
| Caller `OPENCLAW_SHELL` and `OPENCLAW_CLI` | https://docs.openclaw.ai/help/environment | "`OPENCLAW_SHELL=exec`: set for commands run through the `exec` tool." and "`OPENCLAW_CLI=1`: set for child processes spawned by the CLI entry point." | docs | confirmed |
| Profiles at `~/.openclaw-<name>` | https://docs.openclaw.ai/cli; `openclaw --profile work skills list --json` | "`--profile <name>`: Isolate state under `~/.openclaw-<name>`". Output: `managedSkillsDir` `<sandbox>/.openclaw-work/skills`, listing a skill placed there. | 2026.10.1 | confirmed: `instances: { root: "~/.openclaw-{profile}" }` |
| A skill is `<state>/skills/<name>/SKILL.md` | https://docs.openclaw.ai/tools/skills | Source 4 in precedence order is "`<state-dir>/skills`", and "Every skill needs at minimum a `name` and `description` in the frontmatter". | docs | confirmed |
| `<state>/skills` is a folder skills are installed into | https://docs.openclaw.ai/tools/skills | "Add `--global` to install into the shared `~/.openclaw/skills` directory". The managed folders not to edit are the library's "immutable bundles under `skill-library/<skill-id>/revisions/<revision-hash>/`". | docs | confirmed |
| Reads `~/.agents/skills` | https://docs.openclaw.ai/tools/skills; `openclaw skills list --json` with `OPENCLAW_STATE_DIR` set, and with `--profile work` | "`~/.agents/skills` (default state only)" and "When `OPENCLAW_STATE_DIR` points somewhere other than the default", "session skill indexes exclude home-scoped personal or compatibility skill roots such as `~/.agents/skills`." Neither run listed a skill in `~/.agents/skills`. | 2026.10.1 | confirmed only for the default state, so no `reads`: each skill goes to its own folder |
| It edits a skill when asked | https://docs.openclaw.ai/tools/skills | "Operators edit skills outside that directory through their owning tools or files." Skill Workshop: "Every change applies immediately, is announced, and saves the previous version so it can be undone." | docs | confirmed: skills are copies (`place: "copy"`), so an edit shows in `aireg status` and is never overwritten |
| A linked skill folder loads | https://docs.openclaw.ai/tools/skills; `openclaw skills list --json` | "Managed `~/.openclaw/skills` and personal `~/.agents/skills` may contain symlinked skill folders". Output listed a linked folder. | 2026.10.1 | confirmed, though skills are copied (above) |
| Skills list without signing in | `openclaw skills list --json`, no account, no Gateway running | Exit 0, JSON with `managedSkillsDir` and each skill's `name` and `source` (`openclaw-managed` for `<state>/skills`). | 2026.10.1 | confirmed: L2 probe |
| Agents a person defines | https://docs.openclaw.ai/tools/skills | No page names a folder for them. | docs | undocumented: agents left out |
| A trust step before skills load | https://docs.openclaw.ai/tools/skills | No page names one for `<state>/skills`. | docs | confirmed: no `trust` entry |
| A plugin's command is a skill only a person invokes | https://docs.openclaw.ai/tools/skills, read 2026-10-20; `aireg add -g <plugin folder> --all --for openclaw`, the plugin holding `commands/deploy.md`, then `openclaw skills list --json` | "Skills with `disable-model-invocation: true` stay out of the `$` picker and the model's normal prompt, so the model cannot select them on its own." Output listed `toolkit-deploy` with source `openclaw-managed` | 2026.10.1 | confirmed |

## L2 probes

`openclaw skills list --json` from the home folder lists `lint` and `ship` with source `openclaw-managed`. With `--profile work`, it lists the skill placed for `openclaw:work` in `~/.openclaw-work/skills`.

## Left out

- **Agents:** no folder for agents a person defines is documented.
- **A plugin of its own:** a plugin lands as its skills.
- **Its own lock and its persona and memory files:** aireg never writes them.
- **`reload`:** the docs say nothing about when it picks up a change.
