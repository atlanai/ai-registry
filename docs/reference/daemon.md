# aireg daemon

Start, stop or check the background daemon that runs jobs.

## Synopsis

```text
aireg daemon [status]
aireg daemon start
aireg daemon stop
aireg daemon restart
aireg daemon autostart [on | off | status]
```

## Description

The daemon is a background process that runs your [jobs](job.md) on their schedule. Commands that need it start it, so you rarely start it yourself, and several commands starting it at once share one daemon. It also checks for newer versions of aireg and of the adapters you installed, installs any it finds, and restarts itself on them.

The daemon keeps each job's recent runs in `state/aireg.db` under aireg's folder: the newest 200 per job, fewer when a job's runs together record more than 50,000 items. That history is a cache, so a database that can no longer be read is moved aside as `aireg.db.corrupt-<time>` and started again, with a warning in the daemon log. A daemon whose aireg folder is deleted stops on its own.

`aireg daemon` on its own runs `aireg daemon status`.

## Options

`daemon` has no options of its own. It takes `--json`.

## aireg daemon status

Says whether the daemon is running, and if it is, its version and process id, how many jobs are enabled, whether autostart is on, and whether jobs are paused. `status` never starts the daemon.

If another program is listening on the daemon's socket, `status` warns about it instead. A daemon that cannot prove it runs as you counts as another program, and commands send it no credentials; one an older aireg started is replaced by `aireg daemon restart`, or by the next command that needs the daemon.

## aireg daemon start

Starts the daemon. If an older version is running, it is replaced by this one. A newer one is left running.

## aireg daemon stop

Stops the daemon. A run in progress is marked `abandoned`, and runs again when the daemon is back. The next command that needs the daemon starts it again.

## aireg daemon restart

Stops the daemon, then starts this version.

## aireg daemon autostart

Starts the daemon when you log in, so jobs run without a command starting it first.

| Action | Description |
|---|---|
| `on` | Register the daemon with your system's service manager, and start it. |
| `off` | Unregister it. Commands still start the daemon when they need it. |
| `status` | Say whether autostart is on. The default. |

`enable` and `disable` are the same as `on` and `off`.

Autostart is per user, so `autostart on` refuses to run with `sudo`. It registers:

| System | Registered as |
|---|---|
| macOS | A launchd agent, `~/Library/LaunchAgents/sh.aireg.daemon.plist` |
| Linux | A systemd user service, `~/.config/systemd/user/aireg-daemon.service` |
| Windows | A per-user Run key, so it starts when you sign in |

On macOS and Linux the service starts the aireg binary under `cli/current` directly, not the `bin/aireg` script on your `PATH`, so it follows every update. A service registered by an older aireg is moved to it the next time the daemon starts, and takes effect from the next sign-in.

An aireg folder other than your account's own, such as one a different `HOME` or `AIREG_HOME` points at, registers under its own name, so it never replaces your service. `off` unregisters the service and stops starting it at login. On macOS and Linux it also stops the daemon the service manager started; on Windows a running daemon keeps running until it stops.

On macOS, if autostart is registered but not running, check that aireg is allowed in System Settings > General > Login Items.

## JSON output

`status` prints:

```json
{"ok": true, "data": {"status": "ready", "pid": 14300, "jobs": 1, "enabled": 1, "paused": false, "autostart": false}}
```

`status` is `ready` when the daemon is running, `stopping` while it finishes its runs before it exits, `down` when it isn't, and `foreign` when another program is listening on its socket. `autostart` prints whether it changed anything, how it is registered, and where. `start`, `stop` and `restart` print the `status` they leave, the daemon's `pid` while it is running, and whether they `changed` anything: `stop` prints `{"status": "down", "changed": true}`.

## Exit status

- `0`: success, including `status` when the daemon isn't running.
- `1`: the daemon didn't start or stop in time, or autostart couldn't be turned on or off.
- `2`: the action is unknown, or `autostart on` was run with `sudo`.

## Examples

Check the daemon:

```bash
aireg daemon status
```

```text
Not running.
hint: Run `aireg daemon start` to start it now. Commands that need it start it on their own.
```

Start the daemon when you log in:

```bash
aireg daemon autostart on
```

## See also

[`aireg job`](job.md), [`aireg logs`](logs.md), [CLI reference](index.md)
