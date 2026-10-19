# aireg architecture

A map of the CLI's source for contributors. For what aireg does, read the [README](README.md); for what it stores on disk, [storage-spec.md](storage-spec.md).

## Layers

Each folder under `src/` imports its own files and the folders below it. Folders on one rank, `self/` and `engine/`, and `accounts/` and `adapters/`, do not import each other, except that any folder may reach a built-in adapter through its entry points. [`test/architecture.test.ts`](test/architecture.test.ts) enforces this, so a change that needs an upward import is a change to the design. A test file follows the rules of its folder and may also use the shared kit in `test/`.

Import across folders with the package's `#` names, such as `#core/errors.ts`, and with `./` inside a folder. Only `adapter/` uses `../`: it is the published contract, and `tsconfig.types.json` builds its declarations on their own, where `#` names do not resolve.

```
main.ts             parses argv and runs one command; nothing imports it
cli/                commands, prompts, rendering, the console UI and onboarding
daemon/             the background service: JSON-RPC server, jobs, scheduler, run history
self/  engine/      installing, updating and removing aireg itself; what the CLI and the daemon both run
accounts/ adapters/ sign-in and the registries an account reaches; the built-in adapters, git/, local/ and well-known/
core/               everything else, with no knowledge of the layers above
harnesses/          one typed definition per harness; imports only core/harness/contract.ts
adapter/            the public adapter contract; imports nothing else
```

`self/` never reaches the daemon. The update code takes the daemon restart from its caller (`RecycleDaemon` in `self/minimum.ts`), and `aireg self uninstall` stops the daemon in its command module. `harnesses/` sits below `core/`, which loads the built-in list; the contract a harness is written against is the one file of `core/` it imports.

Three folders carry the word adapter. `adapter/` is the contract an adapter is written against, which the npm package exports; `adapters/` holds the adapters built into aireg; and `core/adapter/` is the host side, which finds the adapter for an address, loads it and talks to it.

The architecture test also holds every `adapters/<id>/` to the public contract and its own folder, and to the files `aireg adapter init` scaffolds: `README.md`, `index.ts` (the `defineAdapter` entry), `connect.ts`, `errors.ts` (the adapter's id and its failures) and `compliance.test.ts`, which runs `assertAdapterCompliance` against a real registry. The scaffold, a standalone package, keeps its modules under `src/` and its test under `test/`. A built-in adapter adds `api.ts`, the only module the rest of the CLI imports.

## Where things are defined once

| Concern | Module |
|---|---|
| Every name aireg leaves on disk, in the OS or in a release | `core/product.ts` |
| Every `AIREG_*` environment setting | `core/env.ts` |
| Exit statuses, error codes and the `AiregError` base class | `core/errors.ts` |
| JSON-RPC error codes on the daemon socket | `daemon/rpc/codes.ts` |
| Artifact kinds | `core/kinds.ts` |
| Run states, modes and failure codes | `core/run/model.ts` |
| Job step kinds and fields | `core/config/model.ts` |
| Sync policies, dispositions and operations | `core/sync/policy.ts`, `core/sync/model.ts` |
| Readers for untrusted fields in files and RPC input | `core/fields.ts` |
| Finding, loading and calling the adapter for an address | `core/adapter/` |
| The adapters built into aireg | `adapters/index.ts` |
| What an adapter adds beside the contract: commands, job steps and console tabs | `core/host/` |
| Reading a file spec registry from any `read(path)`, its name rules and document names | `adapter/filespec/` |
| How a source on disk lays out what it holds, and reading one that is not a registry, such as a folder of skills | `adapter/layouts/` |
| The merges a publish writes into `versions.json` and `index.json` | `adapter/filespec/write.ts` |
| Registry authoring: init, index, validate, kinds and offers | `core/filespec/write/` |
| SemVer ordering, digests, safe file reads and writes, and message text helpers | `adapter/semver.ts`, `adapter/spec/canonical.ts`, `adapter/files.ts`, `adapter/text.ts` |
| Paths, the home folder, hashing, file modes and processes | `adapter/paths.ts`, `core/fs/path.ts`, `core/fs/hash.ts`, `core/fs/mode.ts`, `core/process.ts` |
| The lockfile, `.registry/manifest.lock.yml` | `core/lock.ts` |
| Running git | `adapters/git/exec.ts`, reached through `adapters/git/api.ts` |
| The scope a command installs into, and where it places artifacts | `core/store/paths.ts` |
| Edits to a harness's own config file, such as registering a plugin | `core/harness/register/` |
| The command table: names, options, help and docs links | `cli/commands/index.ts` |
| The values a release build stamps in, for tsup and `bun build --compile` | `packaging/defines.ts` |

## How a command runs

1. `main.ts` finds the command in `cli/commands/index.ts` and loads its module.
2. The command parses its options with `cli/options.ts` and reads the scope once: the project's or your user scope's `.registry/manifest.yml` and `manifest.lock.yml`.
3. Installing commands call `engine/pipeline.ts`, which acquires each registry through its adapter (`core/adapter/`), builds a plan (`core/plan/build.ts`) and, through one guarded commit, applies it (`core/plan/apply.ts`) under the scope's lease (`core/lease.ts`). How the run is shown is the command's, through `cli/render/plan.ts`.
4. Placement in each harness folder follows the harness's definition (`src/harnesses/`, applied by `core/harness/`), including any config file the harness needs edited, such as Codex's `config.toml`.
5. A failure is an `AiregError`; `cli/report.ts` prints it, or its `--json` form, and returns its exit status.

Background jobs run the same engine from the daemon (`daemon/runner.ts`), so a sync started by hand and one started by the scheduler behave the same: both write through the pipeline's `commit`, after the same recovery, refusals and hooks.

## Extending aireg

- **A harness:** copy the closest module in `src/harnesses/` to `<id>.ts` and edit it with `defineHarness`, typed by `core/harness/contract.ts`: its `roots`, the `detect` signals that it is installed, and under `kinds` where each kind goes. Use `reads` when it already loads another harness's folder, and `register` and `manifest` entries only when it needs a config edit to load a plugin. List it in `src/harnesses/index.ts`; a test checks every harness's ids, templates and paths. No code branches on a harness's name: extend the contract instead. Record what each mapping rests on in `test/conformance/<id>/EVIDENCE.md` and prove it with a conformance test. A person can also define one as a JSON file, which `core/harness/load.ts` reads and checks.
- **A codec:** a pure function in `core/harness/codecs/`, listed in the `Codec` type, `applyCodec` and `scripts/schema/harness.ts`. A definition only names a codec, so a harness file never carries code.
- **An adapter:** implement the contract in `src/adapter/` with `defineAdapter`, and check it with `assertAdapterCompliance`. `aireg adapter init <id>` scaffolds one as a standalone package that imports the contract from `@atlanai/aireg`. Any other adapter installs from the release server with `aireg adapter install`. A store laid out as the file spec reads through `resolveFromRoot` and, on disk, `openFolderRegistry`; a built-in adapter whose source is a folder reads it through `openLayoutRoot` in `adapter/layouts/`, which tells a registry from a folder of skills and reads either. Built-in adapters live in `src/adapters/<id>/` with the same layout, and say through the contract what the CLI needs, such as `credentialsHint`, `readOnly` and the `fileSpec` capability, so no command branches on an adapter's id.
- **A command:** add its entry to `cli/commands/index.ts`, with its options, examples and docs page, and its module at `cli/commands/<command>.ts`. A command with actions keeps each action's module beside it, in `cli/commands/<command>/<action>.ts`, such as `cli/commands/self/update.ts`. Help and the command map (`aireg --map`) read the table.
- **An environment setting:** add it to `SETTINGS` in `core/env.ts`. A test fails until `docs/reference/environment.md` documents it.
- **An error:** throw `AiregError` with an `ErrorCode`, or extend it for a domain error. A new code needs an exit status in `core/errors.ts` and a row in `docs/reference/output.md`.

## Tests

Vitest runs five projects. `pnpm test` runs them all, and `pnpm run test:unit`, `test:integration`, `test:e2e`, `test:contract` and `test:conformance` run one each.

| Project | Where | What |
|---|---|---|
| unit | `src/**/*.test.ts` beside the code, the tests in `scripts/` and `packaging/`, and `test/architecture.test.ts` | One module at a time, in process, and the import directions between layers. |
| integration | `test/integration/` | Several modules together, in process, such as a client driving the daemon. |
| e2e | `test/e2e/`, `test/scenarios/` | The built CLI in an isolated home. Each built-in command's `--help` is snapshotted. |
| contract | `test/contract/` | The JSON Schemas against the spec, and the generated schemas against their definitions. |
| conformance | `test/conformance/` | Each harness against its evidence: what aireg places, and, with `AIREG_CONFORMANCE=1` and the harness installed, what the harness itself loads. |

`test/kit/` holds what tests share: fixtures that give each test its own home, project, daemon and git identity and clean them up, builders for registries, manifests, locks and plans, and one redaction for paths, digests, times and versions. `test/fixtures/` holds static files only.

A scenario in `test/scenarios/*.md` is a CLI session: `$ aireg ...` lines with the output expected, `? <code>` for an exit status, and `file` blocks for what should be on disk. `UPDATE_SCENARIOS=1` rewrites the expected output after a deliberate change.

`pnpm run verify` runs the typecheck, lint, dead-code check, third-party notices check, build, package check and tests. While you work, `pnpm run fix` formats and drops unused imports, `pnpm run test:watch` reruns every project's tests as files change, and `pnpm run test:e2e -u` updates the help snapshots after a deliberate change.

## Messages

Everything aireg prints is read by a person first: say what happened, then what to do.

- **Errors** are one sentence about what is wrong: `No registry named "acme".`
- **Hints** say what to do next, with any command in backticks: ``Run `aireg registry list` to see the registries this project declares.``
- **Warnings** say what happened and what it means: `Skipped pr-review, which was edited after it was installed.`
- **Results** start with the outcome in the past tense, `Installed 3 artifacts.`, or with "Would" on a dry run.
- **Notes** under a result have a lowercase label of at most five characters; a `next` note is the bare command.
- **Help** summaries and option descriptions are fragments with no period.

Sentences use sentence case and American spelling, with no contractions or em dashes. Count, list and quote with `plural`, `list` and `quoted` from `adapter/text.ts`. Scripts branch on the `--json` error code and the exit status, so the code stays stable while the words improve.

Use the same word for the same thing:

| Say | Not |
|---|---|
| registry | source, alias, origin, marketplace |
| artifact, or skill or agent when the kind is known | item, package, entry |
| this project, your user scope | a bare "scope" |
| lockfile | lock |
| sync | reconcile |
| edited, missing, out of date, changed | drift |
| release server | origin |

## Release builds

A release build stamps four settings into the binary, which never reads them at run time: `AIREG_RELEASE_VERSION` (the version it reports, by default `package.json`'s), `AIREG_RELEASE_ORIGIN` (the release server it updates from; without one it does not update itself), `AIREG_RELEASE_KEYRING` (the keys it trusts to sign releases, base64) and `AIREG_RELEASE_COMMIT`.
