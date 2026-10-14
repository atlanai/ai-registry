# aireg config

Read and write aireg's own settings.

## Synopsis

```text
aireg config [list]
aireg config get <key>
aireg config set <key> <value>
aireg config unset <key>
aireg config path
```

## Description

`aireg config` reads and writes the settings in aireg's `config.yml`, in `~/.aireg/` or `AIREG_HOME`. `aireg config` on its own runs `aireg config list`.

| Action | Description |
|---|---|
| `list` | Print every setting and its value. `ls` is the same command. |
| `get <key>` | Print one setting's value, and nothing else, so it can be used in a script. Prints nothing when the setting isn't set. |
| `set <key> <value>` | Change a setting. |
| `unset <key>` | Put a setting back to its default. `defaults.namespace` is then not set. |
| `path` | Print where `config.yml` is. |

## Settings

| Key | Value | Description |
|---|---|---|
| `defaults.namespace` | `<registry>/<namespace>` | Where [`aireg publish`](publish.md) sends work from this machine when no destination is named. Each part is lowercase letters, digits and hyphens. Used only in a scope that declares that registry. Not set by default; [`aireg init --publish-to`](init.md) sets it too. |
| `defaults.name-collision` | `rename`, `report` or `fail` | What [`aireg add`](add.md), `install` and `update` do with an artifact whose name another installed artifact already has. `rename` installs it under its namespace and name, such as `ops-review`. `report` leaves it out and exits `3`. `fail` installs nothing and exits `2`. Defaults to `rename`. |
| `paused` | `true` or `false` | Stop every background job's schedule. Runs you start yourself still work. The same as [`aireg job pause`](job.md#aireg-job-pause-and-aireg-job-resume). Defaults to `false`. |

## Options

`config` has no options of its own. It takes `--json`.

## JSON output

| Action | `data` |
|---|---|
| `list` | `{"defaults.namespace": null, "defaults.name-collision": "rename", "paused": false}` |
| `get` | `{"key": "paused", "value": false}` |
| `set` | `{"key": "paused", "value": true}` |
| `unset` | `{"key": "defaults.namespace", "value": null}` |
| `path` | `{"path": "/home/me/.aireg/config.yml"}` |

A setting that isn't set is `null`.

## Exit status

- `0`: success.
- `1`: `config.yml` can't be read or written.
- `2`: the key or value is missing, the key is unknown, the action is unknown, or the value isn't valid for the setting.

## Examples

Publish to your team's registry by default:

```bash
aireg config set defaults.namespace acme/engineering
```

Stop publishing there by default:

```bash
aireg config unset defaults.namespace
```

Read a setting in a script:

```bash
namespace=$(aireg config get defaults.namespace)
```

## See also

[Environment and files](environment.md), [`aireg job`](job.md), [CLI reference](index.md)
