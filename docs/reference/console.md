# aireg console

Open a full-screen view of installed artifacts, jobs and registries.

## Synopsis

```text
aireg console
aireg console --json
```

## Description

`aireg console` opens a full-screen view with tabs for an overview, your installed artifacts, background jobs and their runs, your registries, and settings. It needs an interactive terminal. With `--json`, it prints the same state as data instead.

The console shows one registry at a time, in the scope your background sync job keeps current, or your user scope when there is no job, and runs every action in that scope. `1` to `9` or `Tab` switch registries. A git registry takes no publishes, so the console offers none for it, and an edited artifact says to publish it into your clone instead.

### Keys

| Key | Action |
|---|---|
| `←` `→` | Previous or next tab |
| `↑` `↓`, `j` `k` | Move |
| `h` `l` | Fold or unfold a group |
| `Enter` | Expand, or confirm |
| `u` | Take the latest from the registry |
| `p` | Publish a group, or the row that was edited, to a registry that takes publishes |
| `R` | Run a job now |
| `r` | Retry a failed run |
| `Space` | Turn a job on or off |
| `1`-`9`, `Tab` | Show another registry |
| `/` | Filter |
| `g` | Reload |
| `?` | Show the keys |
| `q` | Quit |

## Options

`console` takes `--account <account>`, to open on one registry, named by its name or its account id, and the [global options](options.md#global-options), such as `--json` to print its state as data. It doesn't take the [command options](options.md#command-options), such as `-g`.

## JSON output

`data` holds the console's state: the aireg version, the installed artifacts in groups with a summary, the jobs and their recent runs, whether the daemon is running, the scope shown and its folder, and any problems found.

## Exit status

- `0`: the console closed, or the state was printed.
- `2`: there is no interactive terminal and `--json` wasn't passed, or an option the console doesn't take or an argument was passed.

## Examples

Open the console:

```bash
aireg console
```

Read the same state in a script:

```bash
aireg console --json
```

## See also

[`aireg ui`](ui.md), [`aireg status`](status.md), [`aireg job`](job.md), [CLI reference](index.md)
