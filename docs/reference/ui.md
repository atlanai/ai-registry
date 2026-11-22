# aireg ui

Browse your registries and what is installed, in your browser.

## Opening and reconnecting

Run `aireg ui` and use the browser tab it opens. A server serves the folder it was started
in: a later launch in the same folder, with the same aireg home, reopens it, and a launch in
another folder starts its own. A new server prefers port 3456 and falls back to a free port
if it is occupied. An explicit `--port` never silently falls back.

The launch address carries a token after `#`. The page trades it once for a session cookie
and removes it from the address bar; every tab in that browser then shares the session. A
different browser needs the complete launch address. Keep that address private.

`aireg ui` doesn't open a browser when `CI` or `SSH_CONNECTION` is set, or `BROWSER` is
`none`; it still prints the address. If opening the browser fails, the CLI reports it. If
permissions prevent reading run history, installed artifacts still load with a warning;
unavailable history is not presented as evidence that the machine has no skills.

## Synopsis

```text
aireg ui [--port <port>] [--no-open]
aireg ui --no-open --json
```

## Description

`aireg ui` serves a page from this machine that shows every registry you have declared, what each one publishes, and what is installed here. It reads its state with the same code as [`aireg registry show`](registry.md) and [`aireg console`](console.md), in the scope the console shows: the one your background sync keeps current, or your user scope when there is none.

Each artifact a registry lists is marked with how it is installed: `ok`, `edited`, `missing` and the console's other states, or `available` when it is not installed yet. Work written on this machine shows under **this machine**, in the console's state. When a registry lists an artifact with the same name as such a folder, the page says so; it does not assume the folder is where that artifact came from. A skill a plugin carries is listed under the plugin, installs with it and leaves with it. The inspector shows the artifact's file, whether installed or as its registry serves it, its digests, and each target's link.

From the page you can:

- **Add** from a registry, a git repository or a folder. A dry run shows what would change first. A plugin that carries hooks, servers or programs that run as you is named with what it carries. The dry run lists plugins needing trust; select only those you have reviewed.
- **Sync** the scope shown, as `aireg sync --pull on --publish off --delete off` would.
- **Remove** an installed artifact using [`aireg remove`](remove.md). Unmanaged local folders cannot be removed from the UI. Archive and restore are not offered because the CLI does not provide them.
- **Check the machine**, as [`aireg doctor`](doctor.md) would.

Every action runs as a child of the same `aireg`, so it takes the same lease the CLI does. The process that starts the server keeps serving until you press Ctrl+C. Later launches reopen it and exit.

A registry that is slow to answer does not hold up the page. It shows as being read, and the page updates when it answers or when aireg's files change. A registry that fails is marked unavailable in the sidebar; its details are available on hover. General read failures, including unavailable history, are also listed in **Check this machine**.

### Security

- The server listens on `127.0.0.1` only, on port 3456 by default, with a free-port fallback.
- A running server is recorded in a file only you can read, under `ui/` in aireg's home, named for the folder it serves. Launches in one folder take turns through a lock file beside it, not the lease an install holds, so a running install never holds up `aireg ui`. A later launch reopens a server only when its process is alive and the server on that port answers with the same token; otherwise the file is replaced.
- The address it prints and opens carries a token for this session after `#`, which a browser never sends to a server. Treat the address as a password while the command runs.
- The page sends the token once to `/session`, which answers with an `HttpOnly`, `SameSite=Strict` cookie. Every call and the event stream need that cookie, or the token as a bearer token, compared in constant time.
- A request under any host name but the server's own is refused, which stops a page elsewhere that rebinds its name to `127.0.0.1`. A call also needs the server's own origin and a JSON body, which a page elsewhere cannot send. A body over 64 KiB is refused unread.
- The page names artifacts by key, and the server finds them in aireg's own state; the only path it takes from the page is the address to add from, which follows `--`. An address with a user name and password, or a query, is refused. Every name it passes on rides as `--flag=value`, and a value that starts with `-` is refused.
- An install runs only a plan the server previewed and kept, by its id, for 15 minutes and once. Just before it runs, the server repeats the dry run and refuses if anything it would install, or the trust it needs, changed since the preview. Plugin trust is opt-in: the plan lists plugins that carry what runs as you, and only those can be trusted, through the existing `--trust` flag.
- Every action runs as a child `aireg` and can be cancelled; one that runs past 10 minutes is interrupted, then stopped. Stopping the server interrupts every child, stops any that has not exited 10 seconds later, and waits for them before it exits.
- State the page shows never names a path outside `~`.

## Options

| Option | Description |
|---|---|
| `--port <port>` | Listen on this port, from 1024 to 65535, instead of the default. |
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
