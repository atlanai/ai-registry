# CLI reference

`aireg` installs skills and agents from registries into your coding agents, and publishes the ones you write back to a registry. This section documents aireg's public commands, their options, what they print and the exit status they return.

New to aireg? Start with the [Quickstart](../quickstart.md), then come back here when you need the detail.

## Reading a synopsis

Each command page opens with a synopsis in this form:

```text
aireg add <registry>/<namespace>[/<name>[@<version>]] [options]
```

| Notation | Meaning |
|---|---|
| `<name>` | A value you supply |
| `[...]` | Optional |
| `a | b` | One of the alternatives |
| `...` | Can be repeated |

`aireg <command> --help`, or `aireg help <command> [<action>]`, prints the same synopsis and options in the terminal.

`--json`, `--verbose`, `-q`/`--quiet`, `--color`, `--no-color`, `--log-level`, `--map` and `--help` can go anywhere on the line; `--version` goes before the command name. `-y` and the command options go after the command name; aireg refuses one placed before it, with exit status 2.

## Commands

`aireg --help` lists the commands in the order you meet them: set up, install, check, share, automate and maintain. The sections below follow the same order.

### Set up

| Command | Description |
|---|---|
| [`aireg init`](init.md) | Set up a project (creates .registry/manifest.yml). |
| [`aireg registry`](registry.md) | Declare the registries you install from, or create and check one of your own. |
| [`aireg auth`](auth.md) | Sign in to your registries, and manage the accounts aireg uses. |

### Install

| Command | Description |
|---|---|
| [`aireg search`](search.md) | Find artifacts in the registries you have declared. |
| [`aireg add`](add.md) | Install artifacts from a registry. |
| [`aireg remove`](remove.md) | Uninstall artifacts. |
| [`aireg install`](install.md) | Make this project match its manifest. |
| [`aireg update`](update.md) | Take the newest version each registry offers. |
| [`aireg show`](show.md) | Print an artifact without installing it. |

### Check

| Command | Description |
|---|---|
| [`aireg console`](console.md) | Open a full-screen view of installed artifacts, jobs and registries. |
| [`aireg status`](status.md) | Check installed artifacts against the lockfile, and list the ones nothing manages. |
| [`aireg list`](list.md) | List what is installed. |
| [`aireg outdated`](outdated.md) | Check each registry for newer versions of what is installed. |
| [`aireg targets`](targets.md) | List the targets aireg can install into, and which this machine has. |

### Share

| Command | Description |
|---|---|
| [`aireg sync`](sync.md) | Sync this project with its registries. |
| [`aireg publish`](publish.md) | Publish artifacts to a registry, as new versions. |
| [`aireg watch`](watch.md) | Publish a folder's skills and agents whenever they change. |
| [`aireg skill`, `aireg agent`](kinds.md) | Create a skill or an agent, or start its next version. |

### Automate

| Command | Description |
|---|---|
| [`aireg job`](job.md) | Manage background jobs and read their runs. |
| [`aireg daemon`](daemon.md) | Start, stop or check the background daemon that runs jobs. |

### Maintain

| Command | Description |
|---|---|
| [`aireg config`](config.md) | Read and write aireg's own settings. |
| [`aireg doctor`](doctor.md) | Check that this machine can install artifacts. |
| [`aireg unlock`](unlock.md) | Show or clear a stuck write lock. |
| [`aireg logs`](logs.md) | Read aireg's diagnostic logs. |
| [`aireg adapter`](adapter.md) | Install an adapter, or write a new one. |
| [`aireg self`](self.md) | Update aireg, or uninstall it. |

## Reference pages

- [Options](options.md): the global options, the options several commands share, and when aireg asks questions.
- [Output and exit codes](output.md): what goes to stdout and stderr, the `--json` format, and each exit status.
- [Environment and files](environment.md): the environment variables aireg reads and the files it writes.
