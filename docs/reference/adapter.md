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

An adapter is how aireg reads a kind of registry. Three are built in: `git` reads a registry in a git repository, `local` reads one in a folder, and `well-known` reads a site's Agent Skills index. Any other adapter is a module aireg loads from `~/.aireg/config.yml`, never from a project's manifest; a manifest names an adapter only by its id.

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

An id that is built in, `git`, `local` or `well-known`, is refused.

### Writing an adapter

- `dispatch` in `src/index.ts` names the hosts, URL schemes, sites or local paths whose addresses aireg would send to the adapter.
- `connect` in `src/connect.ts` returns a handle. `resolve` lists each artifact with the file list that describes it, and `fetch` returns one file's bytes, which must match the digest that list gives. A request to `resolve` may carry a `range`, a version range as the file spec defines it, for which `resolve` returns the newest version in the range that installs without a pin. An adapter may ignore it and return what it would without one; aireg then refuses a version outside the range. `resolve` may also return `registry`, what the registry calls itself, with its canonical `https` address as `url` where it has one: a [dependency](kinds.md#dependencies) in another registry names it by that address. `resolve` may also return `newest`: for each artifact it reached, the newest version it holds in any status, where it served another, such as a yanked version above `latest`; a publish counts its next version past it. For a source that is not a registry, `resolve` may return `manifest`: the text of the project manifest the source holds, and where each artifact it holds sits in the source, from which aireg reads the [dependencies of what the project exports](add.md#sources-that-are-not-registries), ignoring a manifest it cannot read.
- `capabilities` turns on publishing and sign-in.

### The adapter contract

Everything `@atlanai/aireg` exports is the contract, and every export carries its documentation in its type declarations. An adapter is a `SourceAdapter`, written with `defineAdapter`:

| Member | What it is |
|---|---|
| `id`, `displayName` | The id a manifest names the adapter by, and what messages call it. |
| `protocol` | The contract version, `ADAPTER_PROTOCOL`. `defineAdapter` fills it in. |
| `artifactKinds`, `publishKinds` | The kinds it serves, and the narrower set it publishes, if any. |
| `dispatch` | The URL schemes, hosts and local paths whose addresses aireg sends to it, and `sites`: URLs of some schemes on any host but those it leaves out. A host claim wins over a site claim, which wins over a scheme claim. |
| `capabilities` | `pinsSource`, `publish`, `auth`, `messages`, `fileSpec`, `namespacePlugins`, `relationships` and `agentFolders`. Anything left out is off. With `namespacePlugins`, each namespace the source lists installs as one plugin in your user scope, named after it, while each artifact keeps a lockfile row of its own. With `relationships`, `publish` stores each version's `relationships` with it, as `artifact.json` does, and `resolve` returns them in its envelope. With `agentFolders`, `publish` stores an agent's files beyond its `AGENT.md`, each at its path, and `resolve` serves them back with it. |
| `configSchema` | The keys a registry's `config:` may carry for it. |
| `auth` | `login`, and optionally `refresh` and `revoke`. `login` returns a `Credential` and, when the registry says who signed in, an `Identity`: a `name` and an optional `account`. |
| `credentialsHint`, `readOnly` | What aireg says when a person needs to set up credentials, or publishes to a registry the adapter only reads. |
| `ready` | The prerequisites it needs on this machine, which `aireg doctor` reports. |
| `connect` | Opens a `SourceHandle` for one registry: `resolve`, `fetch` and `close`, and `publish`, `unpublish` and `localRoot` where it has them. |

`publish` takes a list of `PublishInput`: each artifact's name, kind, namespace, version, files and `contentId`, the content digest of the envelope they make. Its optional `relationships` are the edges the version carries, such as its [dependencies](kinds.md#dependencies): each a `rel_type`, a `to` and an optional `range` and `registry`, as the file spec's `relationships[]` spells them. aireg checks them against the spec before sending, and `contentId` covers them, so a version whose only change is an edge is a new version. It sends them only to an adapter that declares `relationships`: it refuses to publish an artifact that has them anywhere else, before anything is sent. An agent is sent with `AGENT.md` first, its front matter giving the agent's `name` and `description` and its body the instructions, then every other file of a [folder agent](publish.md#folder-agents) at the path it is stored at. aireg sends an agent with files beyond `AGENT.md` only to an adapter that declares `agentFolders`: an export is left out, as one of a kind the adapter doesn't publish is, and a path named on the command line is refused. aireg reports each artifact at the version it sent, so `publish` writes that version or fails: a version the registry already holds with other content is a `conflict`, and is never written as another version instead.

A failure is an `AdapterError` with one of six `Failure` classes, which decide whether aireg retries it and what it tells the person. `assertAdapterCompliance` checks an adapter against a registry it can read, and publishes to it when the adapter declares `relationships` or `agentFolders`, as [Testing an adapter](#testing-an-adapter) warns.

The package also exports what the built-in adapters use: readers and writers for a registry laid out as the [file spec](https://github.com/atlanai/ai-registry/blob/main/spec/file-spec.md) (`resolveFromRoot`, `openFolderRegistry`, `readIndex`, `readVersions`, `mergedIndex`, `mergedVersions`), envelope and digest helpers (`buildEnvelope`, `describeFile`, `contentDigest`, `sha256`), RFC 9457 problem helpers for an adapter that speaks HTTP (`readProblem`, `failureFromStatus`, `retryAfterMs`), SemVer ordering and ranges (`parseRange`, `satisfies`, `maxSatisfying`), and the text helpers aireg's messages are written with.

### Testing an adapter

```sh
npm install
npm test         # the compliance test, run on src/ by Node
npm run build    # compiles src/ to dist/
```

`npm test` runs `assertAdapterCompliance`, which connects to the registry the test names and checks that the adapter implements every capability it turns on, lists only the kinds it declares, and serves bytes that match each file's digest. Point the test at a registry the adapter can read, so every file is fetched and checked. An adapter that declares `relationships` also publishes a skill, or an agent, named `aireg-compliance` there, at version `1.0.0` with one `depends_on` edge, and reads it back. One that declares `agentFolders` publishes an agent named `aireg-compliance-folder` there, at version `1.0.0`, with an `AGENT.md` and one more file, and reads both back.

!!! warning "The compliance test publishes to the registry it checks"
    For an adapter that declares `relationships` or `agentFolders`, point the test at a test registry, never at one people install from. The `aireg-compliance` versions it publishes are published versions like any other, so they are never rewritten, and stay in that registry after the test.

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
