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
- `connect` in `src/connect.ts` returns a handle. `resolve` lists each artifact with the file list that describes it, and `fetch` returns one file's bytes, which must match the digest that list gives.
- An adapter that read the whole listing to its end, such as by paging to the total its server reported, returns `complete: true` from `resolve` under `all`, so aireg removes what the listing no longer holds, as [`install`](install.md) describes.
- `capabilities` turns on publishing and sign-in.

### The adapter contract

Everything `@atlanai/aireg` exports is the contract, and every export carries its documentation in its type declarations. An adapter is a `SourceAdapter`, written with `defineAdapter`:

| Member | What it is |
|---|---|
| `id`, `displayName` | The id a manifest names the adapter by, and what messages call it. |
| `protocol` | The contract version, `ADAPTER_PROTOCOL`. `defineAdapter` fills it in. |
| `artifactKinds`, `publishKinds` | The kinds it serves, and the narrower set it publishes, if any. |
| `dispatch` | The URL schemes, hosts and local paths whose addresses aireg sends to it, and `sites`: URLs of some schemes on any host but those it leaves out. A host claim wins over a site claim, which wins over a scheme claim. |
| `capabilities` | `pinsSource`, `publish`, `auth`, `messages`, `fileSpec` and `namespacePlugins`. Anything left out is off. With `namespacePlugins`, each namespace the source lists installs as one plugin in your user scope, named after it, while each artifact keeps a lockfile row of its own. |
| `configSchema` | The keys a registry's `config:` may carry for it. |
| `auth` | `login`, and optionally `refresh`, `revoke` and `oauth`. `login` returns a `Credential` and, when the registry says who signed in, an `Identity`: a `name` and an optional `account`. `oauth` returns an `OAuthClient`: the OAuth 2.0 server's `issuer`, a public `clientId` registered there for a native app, optional `scopes`, and the loopback `ports` it registered when the server pins them. Without a token, `aireg auth login` signs in there through the browser, with PKCE and a loopback redirect, and hands what it got to `login` as `oauth`. `revoke` runs on sign-out, and for a credential with a refresh token that a new sign-in replaces. |
| `credentialsHint`, `readOnly` | What aireg says when a person needs to set up credentials, or publishes to a registry the adapter only reads. |
| `ready` | The prerequisites it needs on this machine, which `aireg doctor` reports. |
| `connect` | Opens a `SourceHandle` for one registry: `resolve`, `fetch` and `close`, and `publish`, `unpublish` and `localRoot` where it has them. |

A failure is an `AdapterError` with one of six `Failure` classes, which decide whether aireg retries it and what it tells the person. `assertAdapterCompliance` checks an adapter against a registry it can read.

The package also exports what the built-in adapters use: readers and writers for a registry laid out as the [file spec](https://github.com/atlanai/ai-registry/blob/main/spec/file-spec.md) (`resolveFromRoot`, `openFolderRegistry`, `readIndex`, `readVersions`, `mergedIndex`, `mergedVersions`), envelope and digest helpers (`buildEnvelope`, `describeFile`, `contentDigest`, `sha256`), RFC 9457 problem helpers for an adapter that speaks HTTP (`readProblem`, `failureFromStatus`, `retryAfterMs`), SemVer ordering, and the text helpers aireg's messages are written with.

### Declaring kinds

An adapter can add kinds beyond `plugin`, `skill` and `agent`, as data on `extend.kinds`. `extend` is a field of the adapter object beside the contract, and is not part of the published `@atlanai/aireg` types. aireg stores, places, publishes and lists a declared kind as its declaration says, so a new kind needs no new release of aireg.

```js
export default {
  ...defineAdapter({ id: "acme", artifactKinds: ["skill", "knowledge", "prompt"] /* ... */ }),
  extend: {
    kinds: [
      { name: "knowledge", dir: "knowledge", shape: "directory" },
      {
        name: "prompt",
        dir: "prompt_files",
        shape: "file",
        extensions: [".md"],
        targets: { universal: { shape: "file", subdir: "prompts", extension: ".md" } },
      },
    ],
  },
};
```

| Field | What it is |
|---|---|
| `name` | The kind in addresses and on the wire, in the file spec's kind grammar: a lowercase letter, then lowercase letters, digits or underscores, at most 32 characters. |
| `dir` | Its folder in aireg's own copies: one lowercase folder name. aireg keeps these copies under `.kinds/` in its artifacts folder, apart from every namespace folder. |
| `shape` | `directory`, or `file` for a kind that is one file. |
| `extensions` | For a `file` kind, the extensions it takes, such as `[".md"]`. |
| `entry` | For a `directory` kind, the file that marks a folder as one and holds its front matter. Without it, any folder is one, so aireg never looks for such a kind in a target's folders. |
| `description` | One line about the kind. |
| `targets` | Where each target places it, by target id, in the `directory` or `file` mapping a [target file](targets.md#target-files) uses, `register` entries included. A target left out does not load the kind. |

aireg checks every adapter's kinds when `aireg adapter install` installs one, and when it loads adapters before a command that reads kinds and before each background job run:

- These cost that adapter all its kinds, with a warning; other adapters are not affected:
    - a name outside the grammar, or a built-in kind's name or folder
    - a `dir` that a plugin loader reads, such as `commands`, `prompts`, `hooks`, `bin`, `rules`, `agents`, `skills`, `plugins`, `mcp`, `lsp`, `monitors`, `output-styles` or `themes`, or a folder a built-in target keeps plugins in
    - a `file` kind without `extensions`
    - a target that does not exist, or a mapping a target file could not hold
    - a `contents` mapping, a `subdir` that is the target's own folder, or one inside or around a folder where the target keeps a built-in kind
    - a `register` entry in a target's own settings file, such as `settings.json`, or one in a file the target shares, such as `config.toml`, outside a table named for each artifact (`{name}` in the last key of `at`)
- An adapter that does not load is named with its error, since aireg then does not know the kinds it declares.
- Two adapters may declare one kind alike. When they declare it differently, or two kinds share one folder, neither is loaded, and aireg names both adapters.
- A target that already maps the kind, in its own definition or a target file, keeps its own mapping. A target file never maps a declared kind as a plugin's `contents`, and is checked again once the kinds are declared.
- A `register` entry never replaces or removes a table someone else wrote: aireg leaves it, with a warning naming the file and the table, and never deletes a config file on removal.

A declared kind always takes the full address `<registry>/<namespace>/<kind>/<name>`. Only a built-in kind reads as a kind in the short form `<registry>/<kind>/<name>`, so installing or removing an adapter never changes what an address in a manifest means. An address you type with a kind aireg does not know is refused.

A declared kind that no target maps is publish-only. `aireg add` refuses it with exit status 2; `aireg install` and `aireg sync` leave it out with a warning. An export entry with `kind: <name>` publishes its path as one artifact of that kind, every file under a folder, and sends the entry's front matter, its `name` and its `description` as the artifact's fields. `aireg search --kind` takes declared kinds too. A namespace installed as a plugin never carries a declared kind.

A lockfile row of a kind no loaded adapter declares is left exactly as it is, links included, by `install`, `update` and `sync`, each with a warning, and `aireg status` says it did not check its copy.

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
