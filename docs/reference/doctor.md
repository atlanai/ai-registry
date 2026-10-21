# aireg doctor

Check that this machine can install artifacts.

## Synopsis

```text
aireg doctor
```

## Description

`aireg doctor` checks what aireg needs and lists each check with a mark: `✓` when it passes, `!` for a suggestion, `✗` when it stops aireg from installing, and `i` for information. A suggestion or a problem names the command that deals with it on the line below. It only reads; it changes nothing.

It opens with the versions of aireg, Node.js and git. A missing git or an unsupported Node.js version is listed as a problem instead.
Node.js requires 22.23.4+ on major 22, 24.22.1+ on major 24, or 26.12.1 and later.

| Check | What it reports |
|---|---|
| `git` | Listed only when missing. aireg needs git to read git registries. |
| `gh` | Whether the GitHub CLI is installed. When it is, its sign-in reads private GitHub repositories; otherwise git's own credentials do. |
| `symlinks` | Whether this machine can make symbolic links. Without them, aireg copies artifacts into harness folders instead of linking them. |
| `store` | Where aireg keeps its copies of registries. |
| `autostart` | Whether the daemon starts at login, and the command to turn it on. See [`aireg daemon autostart`](daemon.md#aireg-daemon-autostart). |
| `home` | Where aireg keeps its own files. A problem when other users can write to it, since aireg then refuses the credentials stored there. |
| `credentials` | Whether aireg stores any sign-in, and that only you can read the file. |
| `user scope` | Where your user scope is. |
| `aireg skills` | Whether the skills that teach your coding agent to use aireg are installed, and the commands to install them if not. If the skills installed come from another release's tag, such as after aireg updated itself, it shows `!` and the commands that pin them to this release, at the address your user scope declares them from. |
| `telemetry` | aireg sends no usage analytics. An installed aireg checks its release server for updates at most every 15 minutes and installs them, unless `CI` is set or `AIREG_DISABLE_UPDATE_CHECK=1`; a build from source never does. See [Network and privacy](environment.md#network-and-privacy). |
| `updates` | The release channel this aireg updates from and whether a newer one is available, or that it is a build that doesn't update itself. |

It ends with `This machine is ready.`, or the number of problems to fix, and how many suggestions it made.

## Options

`doctor` has no options of its own. It takes `--json`.

## JSON output

```json
{"ok": true, "data": {"problems": 1, "checks": [{"name": "autostart", "ok": true, "detail": "off", "fix": "aireg daemon autostart on"}], "adapters": []}}
```

Each check has its `name`, `ok` and `detail`, and `fix` when a command deals with it. `info` marks one that is only information. `problems` counts the checks that are a problem, and the top-level `ok` is `false` only when aireg can't run here, as the exit status says.

## Exit status

- `0`: aireg can run here. A problem other than a missing git or an old Node.js still exits 0; check `problems` in the JSON.
- `1`: git is missing, or Node.js is too old.
- `2`: an argument was given.

## Examples

Check this machine before installing:

```bash
aireg doctor
```

## See also

[`aireg harnesses`](harnesses.md), [`aireg logs`](logs.md), [CLI reference](index.md)
