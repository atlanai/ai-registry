# Environment and files

## Environment variables

| Variable | Description |
|---|---|
| `AIREG_HOME` | aireg's own folder. Defaults to `~/.aireg`. |
| `AIREG_VERSION` | Read by the installer: the release to install, such as `0.1.0`. Defaults to the latest. |
| `AIREG_USER_SCOPE` | Your user scope, where `-g` installs. Defaults to `~/.registry`. |
| `AIREG_LOG_LEVEL` | The same as `--log-level`. The option wins when both are set. |
| `AIREG_GIT_TIMEOUT_MS` | How long a git operation may take, in whole milliseconds, such as `60000`. Defaults to `300000` (five minutes). Any other value is refused. |
| `AIREG_DISABLE_UPDATE_CHECK` | Any value stops aireg checking for and installing newer versions of itself and of its installed adapters. |
| `AIREG_DISABLE_TELEMETRY`, `DO_NOT_TRACK` | Any value stops aireg sending usage events. |
| `AIREG_RELEASE_CHANNEL` | The release channel aireg updates from. Defaults to `stable`, the only channel published. |
| `AIREG_TOKEN_<NAME>` | A token for the registry named `<NAME>` in capitals, with other characters as `_`, such as `AIREG_TOKEN_ACME_PROD`. How CI signs in. Sent only to the registry of that name the current scope declares: the project's manifest in a project, otherwise your user scope. See [`aireg auth`](auth.md). |
| `AIREG_NO_MODIFY_PATH` | Any value stops the installer adding aireg to your shell's `PATH`. |
| `AIREG_NO_DEFAULT_REGISTRIES` | Any value stops the installer offering the aireg skills. |
| `NO_COLOR` | Any non-empty value turns color off. |
| `FORCE_COLOR`, `CLICOLOR_FORCE` | Any value other than empty or `0` turns color on, even when output isn't a terminal. |
| `CLICOLOR` | `0` turns color off. |
| `CLAUDE_CONFIG_DIR` | Where Claude Code keeps its user folder, if not `~/.claude`. |
| `CODEX_HOME` | Where Codex keeps its user folder, if not `~/.codex`. |
| `COPILOT_HOME` | Where GitHub Copilot keeps its user folder, if not `~/.copilot`. |
| `GEMINI_CLI_HOME` | The folder that holds Gemini CLI's `.gemini` user folder, if not your home folder. |
| `PI_CODING_AGENT_DIR` | Where Pi keeps its user folder, if not `~/.pi/agent`. |
| `AI_AGENT`, `CLAUDECODE`, `CODEX_SANDBOX`, `CODEX_CI`, `CODEX_THREAD_ID`, `CURSOR_AGENT`, `COPILOT_CLI`, `GEMINI_CLI`, `GROK_SESSION_ID`, `PI_CODING_AGENT`, `ANTIGRAVITY_AGENT`, `AUGMENT_AGENT`, `OPENCODE`, `REPL_ID` | Set by a coding agent that runs aireg, which then asks no questions. See [When aireg asks questions](options.md#when-aireg-asks-questions). |
| `CI` | Any value means a CI service runs aireg. aireg then asks no questions, skips its update check, and the installer offers no skills. |
| `BROWSER` | The browser `aireg auth login` and the console open a link in, instead of the system default. The first program of a `:`-separated list (`;` on Windows), run with the link as its only argument. |
| `TERM` | `dumb` turns color and animation off. |
| `HOME`, `USERPROFILE` | Your home folder, in that order, else the one your OS reports. `~` in a path you type means this folder. |
| `XDG_CONFIG_HOME` | Where the fish startup file, the Linux daemon service and OpenCode's `opencode/` user folder go, if not `~/.config`. |
| `XDG_RUNTIME_DIR` | Where the daemon's socket goes, if set to an absolute path. Otherwise the system's temporary folder. A folder there that another user made first is passed over, ending at `run/` in aireg's folder. |
| `SHELL`, `ZDOTDIR` | Which shell startup files the installer adds aireg to, and where zsh keeps them. |
| `GITHUB_ACTIONS` | Set to `true` by GitHub Actions. The installer then puts aireg on `PATH` through `GITHUB_PATH`, and `aireg registry validate` prints problems as annotations. |
| `GITHUB_PATH`, `GITHUB_WORKSPACE` | Set by GitHub Actions: the file later steps read `PATH` from, and the folder annotations are relative to. |
| `GITHUB_BASE_REF` | Set by GitHub Actions on a pull request. `aireg registry validate` compares against it when `--base` isn't given. |

## Project files

A project keeps what it installs in `.registry/`, next to your code:

| Path | Description |
|---|---|
| `.registry/manifest.yml` | What the project installs: its targets, the registries it installs from, and the artifacts it takes from each. Commit it. |
| `.registry/manifest.lock.yml` | The exact version and digest of everything installed. Commit it. |
| `.registry/artifacts/` | The installed copies. The target folders link to them. Committed by default, so a fresh clone works without running aireg; `.registry/.gitignore` shows how to leave them out. |
| `.registry/backups/` | Your own files that stood where aireg installs or removes a link, moved aside rather than deleted, in one folder per command named by its time, such as `20261009T062247Z/claude/skills/lint`. A second command in the same second uses `20261009T062247Z-2`. Each command names what it moves. Not committed. |
| `.registry/leases/` | The write lock a command holds while it changes the project, so two commands never write at once. See [`aireg unlock`](unlock.md). It keeps itself out of git. |
| `.registry/.gitignore` | Written by aireg. It keeps aireg's temporary files and `backups/` out of git. |

Your user scope, `~/.registry/`, holds the same files for what you install with `-g`, except its write lock, which is in `~/.aireg/leases/`.

## aireg's own files

aireg keeps its settings, caches and logs in `~/.aireg/` (or `AIREG_HOME`). Nothing you install lives here.

| Path | Description |
|---|---|
| `config.yml` | aireg's settings and background jobs. Read and write settings with [`aireg config`](config.md). |
| `credentials.json` | The tokens of the registries you signed in to with [`aireg auth login`](auth.md), each with the address it was issued for. Only you can read it. |
| `cache/` | A copy of each registry aireg has read. Safe to delete. |
| `logs/` | Diagnostic logs. Read them with [`aireg logs`](logs.md). |
| `state/` | The daemon's run history, a cache. See [`aireg daemon`](daemon.md). |
| `leases/` | Which process is writing to which scope or registry right now. See [`aireg unlock`](unlock.md). |
| `journals/` | What an install in progress has done, so an interrupted one can be finished. |
| `bin/aireg` | The `aireg` on your `PATH`. |
| `cli/` | The installed versions of aireg. |
| `telemetry-id` | The random ID usage events carry, made once and derived from nothing on your machine. Delete it for a new one. |
| `telemetry-notice` | Which version of the usage-events notice you were shown. |

## Network and privacy

aireg makes four kinds of request:

- **To your registries.** aireg reads each registry you add from where it is: a folder, or a git repository it fetches with your own git configuration and credentials.
- **To its release server.** An installed aireg asks `https://aireg.sh` for its newest release at most every 15 minutes, from a background process after a command and from the [daemon](daemon.md), and installs a newer release it finds. It does the same for each adapter installed with [`aireg adapter install`](adapter.md). When the release server says this version is below the minimum it supports, the next command installs the newer release before it runs. These requests carry no identifiers beyond a `User-Agent: aireg/<version>` header.
- **Usage events.** An installed aireg sends an event to `https://aireg.sh/t` as a JSON `POST` body, from a background process, when `add`, `install`, `remove`, `update`, `search`, `sync` or `publish` changes something or finishes. Event fields stay out of the request URL, and the sender does not follow redirects. Each carries aireg's version, OS and architecture, `ci=1` when `CI` is set, the coding agent running aireg, and a random ID kept in `telemetry-id`. A registry's `owner/repo`, the names of what was installed from it and a search query are sent only for a repository GitHub confirms is public.
- **To GitHub, for that check.** aireg asks `https://api.github.com/repos/<owner>/<repo>` whether a github.com registry is public, without a token. A private repository, an error or no answer counts as private.

The first command after install prints a notice about usage events on stderr and sends nothing; later commands send. Run `aireg config set telemetry false`, or set `DO_NOT_TRACK=1` or `AIREG_DISABLE_TELEMETRY=1`, to stop usage events and the GitHub check. A build from source sends none.

Set `AIREG_DISABLE_UPDATE_CHECK=1` to stop the update requests, then update with [`aireg self update`](self.md) when you choose. aireg also skips them when `CI` is set. A build from source doesn't check or update itself.

## See also

[CLI reference](index.md)
