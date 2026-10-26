# aireg job

Manage background jobs and read their runs.

## Synopsis

```text
aireg job add [<folder>] --registry <registry> [<options>]
aireg job add [<folder>] --watch <folder>... --to <registry>/<namespace> [<options>]
aireg job list
aireg job remove <job>
aireg job start <job> [--mode sync | pull | publish]
aireg job enable <job>
aireg job disable <job>
aireg job pause
aireg job resume
aireg job runs [<run>] [--job <job>] [--state <state>] [--limit <n>] [--follow]
aireg job retry <run>
aireg job cancel <run>
```

`aireg job` on its own runs `aireg job list`.

## Description

A job keeps one scope in sync with one registry in the background, on a schedule. It does the same work as [`aireg sync`](sync.md), in aireg's background daemon. Each time a job runs is a run.

A run never removes an artifact because its registry stopped listing it, since a listing cut short or emptied reads the same: the run ends needing your attention, and names the `aireg remove <name>` that takes it out. The exception is a registry whose adapter says it read the whole listing, as [`install`](install.md) describes.

Jobs are saved in aireg's `config.yml`, and the daemon runs them. A command that needs the daemon starts it. To start it when you log in, run [`aireg daemon autostart on`](daemon.md#aireg-daemon-autostart).

[`aireg add -g`](add.md) adds a job for you, so what you install into your user scope stays current.

### Schedule

A job runs every 15 minutes, or every `--interval` seconds. When a run changes nothing, the wait before the next one doubles each time, up to 30 minutes, but is never shorter than the interval. After a run fails, the wait starts at a minute and doubles each time, up to 30 minutes, and is also never shorter than the interval. With the default interval, a failed run is retried after 15 minutes. A run that takes longer than 30 minutes is stopped.

## Options

Each action's own options are listed with it below. `job add` also takes `-g`, to keep your user scope in sync. See [Command options](options.md#command-options).

## aireg job add

Adds a job that keeps a project, or with `-g` your user scope, in sync with a registry. `<folder>` is the project, and defaults to the current folder. The registry must already be declared in that scope; see [`aireg registry add`](registry.md#aireg-registry-add).

Each registry has one job per scope on this machine. Running `job add` again for the same registry and scope updates that scope's job, under the id it already has; to give it another id with `--name`, remove it first. Another project, or `-g`, gets a job of its own. Options you leave out go back to their defaults, except that folders it already watches are kept, and go on publishing. A new job runs straight away.

| Option | Description |
|---|---|
| `--registry <registry>` | The registry to keep in sync with. |
| `--watch <folder>` | A folder whose skills and agents the job publishes, such as `~/.claude/skills`, as [`aireg watch add`](watch.md#aireg-watch-add) does. Repeat it for more than one. Needs `--to`. |
| `--to <registry>/<namespace>` | Where the watched folders publish. A git registry is refused: aireg doesn't push to git. So is another place than the job's watched folders already publish to. |
| `--interval <seconds>` | How often the job runs. Defaults to `900` (15 minutes). At least `60`, at most `86400`. |
| `--name <name>` | The job's id. Defaults to `job_skills_<registry>`, or `job_skills_<registry>-<folder>` when another scope's job has that id. |
| `--pull <policy>` | What to do when the registry changed something. Defaults to `on`. |
| `--publish <policy>` | What to do with edits made here. Defaults to `report`, or `on` with `--watch`. |
| `--delete <policy>` | What to do with artifacts deleted here that the registry still has. Defaults to `report`. |
| `--adopt <policy>` | What to do with skills and agents written here that no registry has yet. Follows `--publish` unless set. |
| `--claim <policy>` | Whether to manage a folder of yours that holds exactly what the registry publishes. Off unless set. |
| `-s`, `--select <name>` | Also add these artifacts to the scope's manifest, named as inside the registry, such as `pr-review` or `engineering/pr-review`. aireg records each one's full address, skips one the manifest already takes, and refuses a name the registry doesn't publish. Without it, the job syncs what the manifest already names. |
| `--kind <kind>` | A job type an installed adapter adds. |
| `--account <account>` | The account an adapter's job type runs as. |
| `--for <target>[,<target>...]` | For a step an installed adapter adds, the targets it installs into. |

A policy is `on`, `report` or `off`, as for [`aireg sync`](sync.md).

## aireg job list

Lists every job on this machine: its id, registry, its folder, how often it runs, whether it is enabled, and its steps. The folder is the one a job watches, or for a job that watches none, the scope it keeps in sync, with your home folder written as `~`; `--json` gives each path in full. It also says when background sync is paused. `ls` is the same command.

## aireg job remove

Removes a job. The artifacts it installed stay installed, but nothing keeps them up to date in the background any more; aireg warns when that is the case and prints the `aireg job add` that brings it back. For a job that watched folders, aireg forgets the copies it kept of what they hold, in the scope's lockfile and `.registry/artifacts/`, unless another job still watches them; your folders stay as they are, and what the job published stays in the registry. `rm` is the same command.

Since a registry has one job per scope, the job `aireg add -g` starts and the one a watch uses are the same job. To stop publishing a folder and keep the job, run [`aireg watch remove <folder>`](watch.md#aireg-watch-remove) instead.

## aireg job start

Runs a job now, without waiting for its schedule. It works on a disabled job, and while jobs are paused. `start` returns once the run has started; follow it with `aireg job runs <run> --follow`.

| Option | Description |
|---|---|
| `--mode sync | pull | publish` | `pull` only takes what the registry changed, `publish` only sends what changed here, and `sync`, the default, does both. |

## aireg job enable and aireg job disable

Turns one job's schedule on or off. A disabled job is kept, and still runs with `aireg job start`.

## aireg job pause and aireg job resume

Stops or restarts the schedule for every job. Runs you start with `aireg job start` still work while paused. [`aireg config set paused true`](config.md) does the same as `pause`.

## aireg job runs

Lists recent runs, newest first: each run's state, mode, job, what started it, when, how long it took and what it changed, or for a run that failed, why, as the daemon's log recorded it. A run that `aireg sync` started has no job, shown as `-`. With a run id, it shows that run's steps and what happened to each artifact, one line each, and how it ended. For a run that failed, the last line says why, and for a run that left artifacts needing you, the `aireg sync --dry-run` that says what each one needs. `--json` has every event, including the progress the text leaves out, and a failed run's `errorCode`.

A job whose registry takes no publishes, such as a git one, skips the skills and agents written here rather than reporting them every run.

A run's state is `queued`, `running`, `succeeded`, `attention`, `partial`, `failed`, `timed_out`, `canceled` or `abandoned`. A run is `abandoned` when the daemon stopped during it.

`runs` starts the daemon if it isn't running, as `retry` and `cancel` do.

| Option | Description |
|---|---|
| `--job <job>` | Only this job's runs, by its name or id. |
| `--state <state>` | Only runs in this state. |
| `--limit <n>` | How many runs to list, from 1 to 500. Defaults to 50. |
| `--follow` | With a run id, print its events as they happen, until it finishes. |

## aireg job retry

Starts a new run of the same job and mode as an earlier run. Only a run that can be retried qualifies: one that timed out, was abandoned when the daemon stopped, was canceled because the scope was busy, or failed with a temporary error. A run that failed for another reason can't be retried; fix the cause, then run `aireg job start`.

## aireg job cancel

Stops a run that is queued or running.

## JSON output

| Action | `data` |
|---|---|
| `add` | `{"job": {...}, "revision": 4}` |
| `list` | `{"paused": false, "jobs": [...]}` |
| `remove` | `{"jobId": "job_skills_acme"}` |
| `start`, `retry`, `cancel` | `{"run": {...}}` |
| `enable`, `disable` | `{"jobId": "job_skills_acme", "enabled": true}` |
| `pause`, `resume` | `{"paused": true, "revision": 5}` |
| `runs` | `{"runs": [...]}`, or with a run id `{"run": {...}, "events": [...]}` |

With `runs --follow --json`, each event prints as its own line.

A step's `select` entry names the targets whose folders it reads twice: `target` with the current ids, and `harness` with the ids aireg 0.1 knows, kept for compatibility. A job sent back with both is taken when they name the same targets.

## Exit status

- `0`: success.
- `1`: the registry isn't declared, it publishes nothing a `-s` name names, the job or run doesn't exist (including for `start`), the daemon didn't start or isn't running, or the run can't be retried.
- `2`: the action is unknown, `remove`, `enable`, `disable` or `start` was given no job, `pause` or `resume` was given one, an option's value isn't valid, `--registry`, `--watch`, `--to` or `--account` is missing, `start` was given an unknown mode, `retry` or `cancel` was given no run, a run id isn't of the form `run_<uuid>`, or `--to` names a registry that takes no publishes or another place than the job's watched folders publish to.
- `4`: the registry needs a sign-in and there is no account signed in to it. A job can't use `AIREG_TOKEN_<NAME>`, since the daemon never sees it: run `aireg auth login <registry>` first.

## Examples

Keep your user scope in sync with a team registry:

```bash
aireg registry add ../acme-registry -g
aireg job add -g --registry acme
```

Run that job now, then check what it did:

```bash
aireg job start job_skills_acme
aireg job runs
```

Stop syncing:

```bash
aireg job remove job_skills_acme
```

## See also

[`aireg watch`](watch.md), [`aireg daemon`](daemon.md), [`aireg sync`](sync.md), [`aireg console`](console.md), [CLI reference](index.md)
