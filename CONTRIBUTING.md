# Contributing

Thanks for helping. This repository holds the ai-registry file spec, the aireg CLI, the documentation site and example registries.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately, as described in [SECURITY.md](SECURITY.md), not in public issues.

## Ways to contribute

- **Report a bug or ask for a feature** by [opening an issue](https://github.com/atlanai/ai-registry/issues/new/choose). For a bug, include `aireg --version`, your OS, the coding agents involved and the steps to reproduce it.
- **Fix the docs.** Small fixes can go straight to a pull request.
- **Propose a spec change.** Open a feature request first, with **File spec or schemas** as the area; see [Spec changes](#spec-changes).
- **Ask a question** by opening an issue.
- **Work on the CLI.** Start with issues labeled `good first issue`. Comment on an issue before you start, so two people don't work on the same thing.

## Proposing changes

- Describe the problem, intended behavior, and how the change will be verified.
- Keep changes focused. Separate unrelated cleanup from the requested work.

Bug fixes and support for more coding agents can go straight to a pull request. Open an issue first for:

- new commands, flags and config keys, since aireg has to keep each one working
- changes that break existing registries, manifests or lockfiles
- changes to public contracts or architecture
- spec changes (see [Spec changes](#spec-changes))

### Spec changes

The file spec is a draft (v0.1), so it can still change, but every change affects people who read or write registries. For a spec change:

1. Open a feature request with **File spec or schemas** as the area. Describe the problem, the proposal, and its effect on existing registries and clients.
2. Once a maintainer agrees the direction, open a pull request that changes the spec text, the schemas in `spec/schemas/`, the examples, and the checks together.
3. Mark a change that breaks existing registries or clients as breaking (see [Pull requests](#pull-requests)).

## Development setup

You need git and Python 3 for the spec checks and docs. For the CLI you also need Node.js 22.20 or later and pnpm; enable pnpm with `corepack enable pnpm`.

Fork the repository on GitHub, then clone your fork and create a branch:

```sh
git clone https://github.com/<your-username>/ai-registry.git
cd ai-registry
git checkout -b <your-branch>
```

### CLI

```sh
cd cli
pnpm install --frozen-lockfile
pnpm dev --help       # run aireg from source, no build needed
pnpm run verify       # the CLI checks CI runs
```

`pnpm dev` uses your real `~/.aireg` and harness folders. To try something without touching them, set `HOME` and `AIREG_HOME` to a temporary folder first. Before changing the code, read [cli/ARCHITECTURE.md](cli/ARCHITECTURE.md): it maps the source and the tests, and says how to add a harness, an adapter, a command, a setting or an error, and how to word what aireg prints.

The schemas in `cli/schema/` are generated. Edit the definitions under `cli/scripts/schema/`, then run `pnpm run schema`. A test fails if they drift.

`THIRD_PARTY_NOTICES.txt` is generated too. After changing production dependencies or the Bun version, run `pnpm run notices`. CI runs `pnpm run notices --check`, which fails on a stale file or a license outside the allowlist.

Add a test that fails without your change and passes with it, written against the public interface.

Opt in to local pre-push checks with `git config core.hooksPath .githooks`; this replaces `.git/hooks` for this clone. The hook runs the typecheck and changed-file lint, requires a clean `cli/` working tree, and accepts only the checked-out commit. Set `LINT_BASE` to override the default comparison base, `origin/main`.

Run the hook regression tests with `python3 -m unittest discover -s tools -p test_pre_push.py`.

### Spec and schemas

```sh
python3 tools/check.py examples/acme-registry    # verify a registry against the spec, recomputing every digest
python3 tools/check.py examples/aireg
python3 tools/check_schemas.py                   # check spec/schemas/ and validate the examples against them
```

Both use only the standard library, but the second validates the examples only when `jsonschema` is installed. Install the pinned version with `python3 -m pip install -r tools/requirements.txt`; CI passes `--require-jsonschema`, so a missing `jsonschema` fails there instead of skipping. Run both when you change the specification, the schemas, or an example.

### Documentation

```sh
python3 -m pip install -r docs/requirements.txt
mkdocs serve             # preview at http://127.0.0.1:8000/ai-registry/
mkdocs build --strict    # what CI runs
```

Set `DOCS_SITE_URL=http://127.0.0.1:8000/` to serve at the root instead. The figures in `docs/assets/` come from `python3 tools/build_figures.py`. Edit the script, not the SVGs, and check the output with `--check`. The site links to the specification rather than copying it.

An install pin such as `AIREG_VERSION=0.1.4` in a code block, in the docs or in the newest version of an aireg skill, names the version in `cli/package.json`. `python3 tools/check_pins.py` checks them, and CI runs it, so a release that changes the version moves the pins with it.

Use sentence case headings and avoid em dashes.

## Pull requests

- Fill in the pull request template: what changed, why, what verification ran, and any unresolved limitations.
- Write the title and commit messages as [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<optional-scope>): <imperative summary>`, for example `fix(cli): …` or `docs(site): …`. The type is one of `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore` or `revert`, and CI checks the title. Mark a change that breaks a public contract with `!` in the header and a `BREAKING CHANGE:` footer.
- CI labels the pull request by the paths it changes: `area:cli`, `area:spec`, `area:examples`, `area:tools`, `documentation`, or `area:ci` when only `.github/` changes. A `!` in the title adds `breaking`, and taking it out removes the label. When no path matches, a maintainer adds the label. The title and labels become the pull request's line in the release notes, grouped by label as set in [`.github/release.yml`](.github/release.yml). GitHub Releases are the changelog; there is no separate changelog file.
- CI must pass. It runs the CLI checks on Linux, macOS and Windows, checks the third-party notices, builds the standalone binaries, runs the spec checks, builds the docs, and scans for secrets. On your first pull request, CI may wait for a maintainer to approve the run.
- Changes to a path with a code owner get that owner's review; see [CODEOWNERS](.github/CODEOWNERS).
- Do not include secrets, private data, or internal operational material in code, documentation, fixtures, or examples. Use synthetic data.

## Use of AI

You're welcome to use coding agents and other AI tools. [AGENTS.md](AGENTS.md) tells them how to work in this repository.

- A person opens every issue and pull request, understands the change, and answers review questions in their own words.
- Say in the pull request how you used AI, for example "Written with Claude Code; I reviewed and tested it." Typo and formatting fixes don't need this.
- We close pull requests that an agent opened on its own, with no person reviewing the change.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE). There is no CLA to sign and no sign-off to add.
