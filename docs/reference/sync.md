# aireg sync

Sync this project with its registries.

## Synopsis

```text
aireg sync [<registry>] [--pull <policy>] [--publish <policy>] [--delete <policy>]
           [--adopt <policy>] [--claim <policy>] [-s <name>]... [-g]
aireg sync --dry-run [--claim <policy>] [-g]
aireg sync resolve <name> --mine | --theirs [-g]
```

`<policy>` is `on`, `report` or `off`.

## Description

`aireg sync` compares what is installed in the scope with what its registries publish, and settles the difference. It works through each kind of change separately, and a policy for each says what to do:

| Option | The change | Default |
|---|---|---|
| `--pull` | The registry published something new or changed. | `on` |
| `--publish` | You edited an installed artifact here. | `report` |
| `--delete` | You deleted an artifact here that the registry still publishes. | `report` |
| `--adopt` | You wrote a skill or agent here that no registry publishes yet. | follows `--publish` |
| `--claim` | A folder of yours holds exactly what the registry publishes, so aireg could manage it. | `off` |

`on` makes the change, `report` lists it as needing your attention, and `off` ignores it. An artifact its registry stops listing isn't a change to pull: a listing cut short or emptied reads the same, so `sync` keeps the artifact, reports it as needing your attention, and names the `aireg remove <name>` that takes it out. When the registry's adapter says it read the whole listing, `sync` treats the artifact as deleted from the registry instead, as [`install`](install.md) describes. So by default `sync` takes what moved in the registry and reports what you changed, without publishing anything. A registry in a git repository is only reported to, since aireg doesn't push to git. A conflict, where both sides changed, is always reported and never decided for you.

Name a registry to sync only that one, and pass `-s` to sync only some artifacts.

`sync` runs in aireg's background daemon, which it starts if needed, and prints each change as it settles: what happened to the artifact, and for one that needs you, why, in the words the dry run uses. It ends with a count of what it checked and what it changed, and with the hint the dry run would give for what it left, such as `aireg sync resolve` for a conflict. It says the scope is in sync only when it left nothing out: what a policy set to `off` left alone is counted as left as it is. An `AIREG_TOKEN_<NAME>` set for the command is handed to the daemon in memory for that run alone: it is never stored, and background jobs never see it. To keep a scope in sync on a schedule, add a background job with [`aireg job add`](job.md#aireg-job-add).

### Dry run

With `--dry-run`, `sync` lists what it would do and changes nothing. It reports on the registry you name, or on every registry, and on every artifact in the scope from it: `-s` and the `--pull`, `--publish`, `--delete` and `--adopt` policies don't change it. `--claim on` does, by listing the folders of yours aireg would take over. Each artifact that isn't in sync gets an action, from the table under [JSON output](#json-output). Then it lists work it found in your harness folders: skills and agents written here that no registry publishes, and ones already published that the scope doesn't declare.

## Options

| Option | Description |
|---|---|
| `--pull`, `--publish`, `--delete`, `--adopt`, `--claim` | The policy for each kind of change. See above. |
| `-s`, `--select <name>` | Sync only these artifacts. Not used with `--dry-run`. |
| `--dry-run` | List what would happen, and change nothing. |

`sync` also takes `-g`. See [Command options](options.md#command-options).

## aireg sync resolve

Settles a conflict, where you edited an artifact and its registry changed it too.

| Option | Description |
|---|---|
| `--mine` | Keep your copy, and publish it as a new version. A git registry takes no publishes, so aireg refuses this and names the `aireg publish` that sends your copy into your clone. |
| `--theirs` | Take the registry's copy, and drop your edit. For an artifact from a watched folder, the registry's copy is also written into that folder, and yours is moved to `.registry/backups/` first. |
| `--job <job>` | Settle a conflict that a background job left waiting. Takes the job's name or id. |

`<name>` is the installed artifact's name, as [`aireg list`](list.md) shows it. `resolve` runs in the daemon as `sync` does, and prints how the artifact settled.

## JSON output

With `--dry-run --json`, `data` holds `dryRun`, the scope, every artifact with its `registry` and `disposition` (`synced`, `pull`, `pull-delete`, `publish`, `conflict`, `adopt`, `archive`, `removed`, `unknown` or `unavailable`), and the work found in your harness folders under `local`, `undeclared`, `linkable`, `changed` and `kept`. Without `--dry-run`, `data` holds `dryRun`, the scope and a run per registry, with its `id`, `state`, `counts`, the `artifacts` that changed, need you, or failed, each with its `outcome`, `operation` and `disposition`, and `warnings` naming any file of yours it moved to backups or left in place. `sync resolve --json` prints its run once it has finished.

Each artifact's `disposition` says how the two sides differ, and the text output shows it as an action:

| `disposition` | Action | Meaning |
|---|---|---|
| `synced` | | The scope and the registry hold the same bytes. |
| `pull` | `pull` | Only the registry changed it. |
| `pull-delete` | `remove` | The manifest no longer asks for it, and it is unchanged here. |
| `publish` | `publish` | Only you changed it, here. |
| `conflict` | `conflict` | Both sides changed it. Settle it with `aireg sync resolve`. |
| `adopt` | `adopt` | You wrote it here, and no registry publishes it yet. |
| `archive` | `archive` | You deleted it here, and the registry still publishes it. |
| `removed` | `remove` | Both sides deleted it. |
| `unknown` | `unknown` | Nothing records what was installed, so aireg can't tell which side changed. |
| `unavailable` | `unavailable` | The registry lists it but would not serve it, or no longer lists it. |

## Exit status

- `0`: everything is settled.
- `1`: the named registry isn't declared, a registry couldn't be synced, or `resolve` couldn't settle the artifact. Run [`aireg logs --daemon --level warn`](logs.md) to see why.
- `2`: run outside a project without `-g`, the scope declares no registry, more than one registry was named, a policy isn't `on`, `report` or `off`, or, for `resolve`, neither or both of `--mine` and `--theirs` were passed.
- `3`: something needs your attention.

## Examples

See what would change, without changing anything:

```bash
aireg sync --dry-run
```

Take what moved in the registries, and publish what you edited here:

```bash
aireg sync --publish on
```

Keep your edit to a skill as a new version:

```bash
aireg sync resolve pr-review --mine
```

## See also

[`aireg publish`](publish.md), [`aireg status`](status.md), [`aireg update`](update.md), [CLI reference](index.md)
