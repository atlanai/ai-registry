# aireg adapter

Install an adapter, or write a new one.

## Synopsis

```text
aireg adapter install <id>[@<version>] [--dry-run] [--force] [--yes]
aireg adapter list
aireg adapter remove <id> [--dry-run]
aireg adapter init <id> [--dir <folder>] [--dry-run] [--force]
```

## Description

An adapter is how aireg reads a kind of registry. Two are built in: `git` reads a registry in a git repository, and `local` reads one in a folder. Any other adapter is a module aireg loads from `~/.aireg/config.yml`, never from a project's manifest; a manifest names an adapter only by its id.

aireg installs adapters as signed releases that it verifies against its release server's keys. `aireg adapter init` writes a new adapter package to develop, test and contribute.

`aireg adapter` on its own runs `aireg adapter list`.

## aireg adapter install

Downloads an adapter from the release server, checks it against the release server's signing keys, and records it in `~/.aireg/config.yml`. Name a version with `@<version>`, such as `acme@1.4.0`. A running daemon restarts to load it.

After that, aireg keeps the adapter on its newest signed release: the background update check and the daemon install a newer release when the release server has one, and the daemon restarts to load it. Set `AIREG_DISABLE_UPDATE_CHECK=1` to stop this.

An adapter runs inside aireg with your access. For an adapter aireg does not trust, it asks before installing; without a terminal, pass `--yes`. A build of aireg with no release server, such as one run from source, refuses to install.

| Option | Description |
|---|---|
| `--dry-run` | Print what would be installed without installing it. |
| `--force` | Install it again even if that version is installed. |
| `-y`, `--yes` | Install an adapter aireg does not trust without asking. |

## aireg adapter list

Lists the adapters installed from the release server, with each one's version and module. Built-in adapters aren't listed; they always load. `ls` is the same command.

## aireg adapter remove

Removes an installed adapter and the versions aireg downloaded for it. `rm` is the same command. Its data folder stays. `--dry-run` prints what would be removed.

## aireg adapter init

Writes a standalone package for a new adapter, in a folder named after the id or in `--dir`:

```text
acme/
├── .gitignore               # node_modules/ and dist/
├── package.json             # depends on @atlanai/aireg as a peer, and for development
├── tsconfig.json            # compiles src/ to dist/
├── README.md                # the development loop
├── src/index.ts             # the adapter: id, kinds, dispatch, capabilities
├── src/connect.ts           # resolve and fetch, to implement
├── src/errors.ts            # failures named with the adapter's id
└── test/compliance.test.ts  # assertAdapterCompliance against the adapter
```

The package imports the adapter contract from `@atlanai/aireg`: `defineAdapter`, `assertAdapterCompliance`, `AdapterError` and the types they take. Its peer dependency is a caret range on this version of the contract, such as `^0.1`: while aireg is 0.x it accepts later patch releases of the same minor, and from 1.0 on later minor releases too.

| Option | Description |
|---|---|
| `--dir <folder>` | The folder to write the package into. |
| `--dry-run` | Print what would be written without writing it. |
| `--force` | Overwrite the folder if it exists. |

An id that is built in, `git` or `local`, is refused.

### Writing an adapter

- `dispatch` in `src/index.ts` names the hosts, URL schemes or local paths whose addresses aireg would send to the adapter.
- `connect` in `src/connect.ts` returns a handle. `resolve` lists each artifact with the file list that describes it, and `fetch` returns one file's bytes, which must match the digest that list gives.
- `capabilities` turns on publishing and sign-in.

### The adapter contract

Everything `@atlanai/aireg` exports is the contract, and every export carries its documentation in its type declarations. An adapter is a `SourceAdapter`, written with `defineAdapter`:

| Member | What it is |
|---|---|
| `id`, `displayName` | The id a manifest names the adapter by, and what messages call it. |
| `protocol` | The contract version, `ADAPTER_PROTOCOL`. `defineAdapter` fills it in. |
| `artifactKinds`, `publishKinds` | The kinds it serves, and the narrower set it publishes, if any. |
| `dispatch` | The URL schemes, hosts and local paths whose addresses aireg sends to it. |
| `capabilities` | `pinsSource`, `publish`, `auth`, `messages`, `fileSpec` and `namespacePlugins`. Anything left out is off. With `namespacePlugins`, each namespace the source lists installs as one plugin in your user scope, named after it, while each artifact keeps a lockfile row of its own. |
| `configSchema` | The keys a registry's `config:` may carry for it. |
| `auth` | `login`, and optionally `refresh` and `revoke`. `login` returns a `Credential` and, when the registry says who signed in, an `Identity`: a `name` and an optional `account`. |
| `credentialsHint`, `readOnly` | What aireg says when a person needs to set up credentials, or publishes to a registry the adapter only reads. |
| `ready` | The prerequisites it needs on this machine, which `aireg doctor` reports. |
| `connect` | Opens a `SourceHandle` for one registry: `resolve`, `fetch` and `close`, and `publish`, `unpublish` and `localRoot` where it has them. |

A failure is an `AdapterError` with one of six `Failure` classes, which decide whether aireg retries it and what it tells the person. `assertAdapterCompliance` checks an adapter against a registry it can read.

The package also exports what the built-in adapters use: readers and writers for a registry laid out as the [file spec](https://github.com/atlanai/ai-registry/blob/main/spec/file-spec.md) (`resolveFromRoot`, `openFolderRegistry`, `readIndex`, `readVersions`, `mergedIndex`, `mergedVersions`), envelope and digest helpers (`buildEnvelope`, `describeFile`, `contentDigest`, `sha256`), RFC 9457 problem helpers for an adapter that speaks HTTP (`readProblem`, `failureFromStatus`, `retryAfterMs`), SemVer ordering, and the text helpers aireg's messages are written with.

### Testing an adapter

```sh
npm install
npm test         # the compliance test, run on src/ by Node
npm run build    # compiles src/ to dist/
```

`npm test` runs `assertAdapterCompliance`, which connects to the registry the test names and checks that the adapter implements every capability it turns on, lists only the kinds it declares, and serves bytes that match each file's digest. Point the test at a registry the adapter can read, so every file is fetched and checked.

## JSON output

`list`:

```json
{"ok": true, "data": {"adapters": [{"id": "acme", "specifier": "./adapters/acme/1.4.0/adapter.mjs"}]}}
```

`install` and `remove` return `dryRun`, `action`, `id`, `specifier` and, for `install`, `version`. `init` returns `id`, `dir`, the `files` it wrote and `dryRun`.

## Exit status

- `0`: done, or already installed.
- `1`: the release server can't be reached, the adapter doesn't verify, this build has no release server, no adapter of that id is installed, or the folder for `init` already exists.
- `2`: no id was named, the id isn't valid or is built in, a version isn't exact, or an adapter aireg does not trust needs `--yes` without a terminal.

## Examples

Install an adapter:

```bash
aireg adapter install acme
```

Start a new adapter:

```bash
aireg adapter init acme
```

## See also

[`aireg registry`](registry.md), [`aireg doctor`](doctor.md), [Environment and files](environment.md), [CLI reference](index.md)
