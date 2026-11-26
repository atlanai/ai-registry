# aireg usage

Count runs of installed skills and agents, and share them with registries.

## Synopsis

```text
aireg usage [show] [--days <n>]
aireg usage share
aireg usage share <registry> [--as <name>]
aireg usage share <registry> --off
aireg usage send
```

## Description

A coding agent records each session on your machine. `aireg usage` reads those records and counts a **run** each time a session loaded a skill or agent you installed from a registry, at most once per turn. It finds the version that ran by matching the folder the agent read to your lockfiles: your user scope's, and the project's the session ran in. A skill nothing installed, such as one you wrote yourself, isn't counted.

aireg reads the session records of these targets:

| Target | Records it reads | A run is |
|---|---|---|
| Claude Code | `~/.claude/projects/` | a skill Claude Code loaded, whether the model chose it or you typed its command |
| Codex | `~/.codex/sessions/` | a command Codex ran that opened a skill's `SKILL.md` |

The first time, it reads records changed in the last 30 days. After that it reads only what was added since, so a run is never counted twice. It keeps the runs it counted in aireg's home, in `usage/`: the version, the target, when it ran and whether you or the model started it. It keeps nothing of the conversation.

### show

`aireg usage`, or `aireg usage show`, counts new runs and lists each version that ran in the last 30 days on this machine: its registry, how many runs, how many of them you started, the targets it ran in and when it last ran. Below the table it names each registry you share usage with.

### share

A registry asks for usage by naming an OpenTelemetry endpoint in its `registry.json` ([file spec](https://github.com/atlanai/ai-registry/blob/main/spec/file-spec.md) section 14). Nothing is sent until you agree, for each registry.

`aireg usage share <registry>` reads the registry's `registry.json` now, through the same address and credentials it installs with, and records that you agree to send runs of that registry's skills and agents to the endpoint it names. Runs from before then stay on your machine, and are never sent. `<registry>` is the registry's name as [`aireg list`](list.md) shows it, in your user scope or the current project.

Each run is sent as one OpenTelemetry span: the version that ran and its digest, the target, whether you or the model started it, when it ran, rounded to the hour unless the registry asks otherwise, and who you are to that registry. That is a pseudonym, derived with a key that never leaves your machine and different for every registry, unless the registry asks for names; then you choose one with `--as`. A span never carries a prompt, an answer, a file path or a project name.

aireg records the terms you agreed to: the endpoint, whether the registry gets a pseudonym or a name, and how precisely times are sent. When the registry changes any of them later, aireg sends it nothing until you run `aireg usage share <registry>` again. Agreeing again to the same terms changes nothing. `--off` stops sending to it, and waits for a send in progress to stop first; runs already sent stay with the endpoint.

`aireg usage share` with no registry lists the registries you share with.

### send

`aireg usage send` counts new runs and sends each registry you share with the runs its endpoint doesn't have yet. The [daemon](daemon.md) does the same every 15 minutes, but only once you share with a registry; until then it reads no session records.

An endpoint that needs a header, such as an API key, takes it from `AIREG_USAGE_HEADERS_<NAME>`, for the registry named `<NAME>`; see [Environment and files](environment.md). The daemon reads it from the environment it started in, so set it there too, or run `aireg usage send` from a shell that has it. aireg sends OTLP over HTTP as protobuf, to `<endpoint>/v1/traces`, and doesn't follow redirects.

## Options

| Option | Action | Description |
|---|---|---|
| `--days <n>` | `show` | How many days back to count, from 1 to 365. Defaults to 30. |
| `--as <name>` | `share` | Your name in what is sent, for a registry that asks for names: lowercase letters, digits and hyphens. Refused for a registry that asks for pseudonyms. |
| `--off` | `share` | Stop sending runs to the registry. |

## JSON output

`show`:

```json
{"ok": true, "data": {"days": 30, "artifacts": [{"registry": "acme", "ref": "engineering/skill/pr-review@1.2.0", "runs": 12, "byYou": 3, "targets": ["claude-code", "codex"], "last": "2026-11-24T09:15:42.000Z"}], "sharing": [{"registry": "acme", "otlp": "https://otel.acme.example", "as": null}]}}
```

`share <registry>` prints `{"registry", "otlp", "sharing", "reporter", "as"}`, with `sharing` `false` after `--off`. `share` with no registry prints `{"sharing": [...]}`.

`send`:

```json
{"ok": true, "data": {"registries": [{"registry": "acme", "otlp": "https://otel.acme.example", "sent": 4, "pending": 0, "stopped": null}]}}
```

`stopped` says why runs were left unsent, such as an endpoint that couldn't be reached; `ok` is then `false`.

## Exit status

- `0`: success.
- `1`: `send` left runs unsent for a registry.
- `2`: a bad argument, a registry that asks for no usage, or a name the registry can't take.

## Examples

See which installed skills ran this week:

```bash
aireg usage --days 7
```

Send acme's runs to the endpoint its `registry.json` names, then send what is already counted:

```bash
aireg usage share acme
aireg usage send
```

## See also

[`aireg list`](list.md), [`aireg daemon`](daemon.md), [Environment and files](environment.md), [CLI reference](index.md)
