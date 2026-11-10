# aireg ui

Browse your registries and what is installed, in your browser.

## Synopsis

```text
aireg ui [--port <port>] [--no-open]
aireg ui --no-open --json
```

## Description

`aireg ui` serves a page from this machine that shows every registry you have declared, what each one publishes, and what is installed here. It reads its state with the same code as [`aireg registry show`](registry.md) and [`aireg console`](console.md), in the scope the console shows: the one your background sync keeps current, or your user scope when there is none.

Each artifact a registry lists is marked with how it is installed: `ok`, `edited`, `missing` and the console's other states, or `available` when it is not installed yet. Work written on this machine shows under **this machine**, in the console's state. When a registry lists an artifact with the same name as such a folder, the page says so; it does not assume the folder is where that artifact came from. A skill a plugin carries is listed under the plugin, installs with it and leaves with it. The inspector shows the artifact's file, whether installed or as its registry serves it, its digests, and each target's link.

From the page you can:

- **Add** from a registry, a git repository or a folder. A dry run shows what would change first. A plugin that carries hooks, servers or programs that run as you is named with what it carries, and installs only once you tick it.
- **Sync** the scope shown, as `aireg sync --pull on --publish off --delete off` would.
- **Retire** an artifact. One a registry installed is removed as [`aireg remove`](remove.md) would. A folder written here is moved to `retired` in aireg's home, from where **Restore** puts it back.
- **Check the machine**, as [`aireg doctor`](doctor.md) would.

Every action runs as a child of the same `aireg`, so it takes the same lease the CLI does. The command keeps serving until you press Ctrl+C.

A registry that is slow to answer does not hold up the page. It shows as being read, and the page reads again every few seconds until it answers. A registry that fails says why at the top of the page.

### Security

- The server listens on `127.0.0.1` only, on a free port unless you pass `--port`.
- The address it prints and opens carries a token for this session after `#`, which a browser never sends to a server. Treat the address as a password while the command runs.
- Every API request needs the token. A request under any host name but the server's own is refused, which stops a page elsewhere that rebinds its name to `127.0.0.1`. An action also needs the server's own origin and a JSON body, which a page elsewhere cannot send.
- The page names artifacts by key, and the server finds them in aireg's own state; the only path it takes from the page is the address to add from, which follows `--`. Every name it passes on rides as `--flag=value`, and a value that starts with `-` is refused.
- Trust is never on by default. The page can trust only a plugin that the last dry run of the same address named in the last ten minutes, and only while what the plugin runs is what that dry run read: the install reads the plan again and refuses if it changed.
- Retire writes nothing inside the folder it moves, and restore never writes over anything.

## Options

| Option | Description |
|---|---|
| `--port <port>` | Listen on this port, from 1024 to 65535, instead of a free one. |
| `--no-open` | Print the address without opening a browser. |

`ui` also takes the [global options](options.md#global-options), such as `--json`. It doesn't take the [command options](options.md#command-options), such as `-g`.

## JSON output

`aireg ui --json` prints one line before it serves: `data.url` is the page's address, token included, and `data.port` is the port.

## Exit status

- `0`: the server stopped on Ctrl+C or `SIGTERM`.
- `1`: the port passed with `--port` is already in use.
- `2`: an option `ui` doesn't take, a port out of range, or an argument was passed.

## Examples

Open it in your browser:

```bash
aireg ui
```

Serve it for a script, without a browser:

```bash
aireg ui --no-open --json
```

## See also

[`aireg registry`](registry.md), [`aireg console`](console.md), [`aireg status`](status.md), [CLI reference](index.md)
