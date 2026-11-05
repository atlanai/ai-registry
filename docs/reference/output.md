# Output and exit codes

## stdout and stderr

aireg prints a command's result on stdout. Warnings, hints, errors and the steps that `--verbose` prints go to stderr, so a script can read stdout without filtering them out.

An error prints as `error:`, then its `code:` and a `hint:` line that says what to do about it:

```text
error: Unknown command "stauts".
  code: usage
hint: Did you mean `aireg status`? Run `aireg --help` for the list.
```

An error with no particular code, `error`, prints no `code:` line.

With `--quiet`, aireg prints only the result, warnings and errors.

## Color

By default aireg colors text only on a terminal, and not when `TERM=dumb`, `CI` or `CLICOLOR=0` is set. The first of these that applies decides instead:

1. `--color always` or `--color never` (`--no-color` is `--color never`)
2. `NO_COLOR` turns color off
3. `FORCE_COLOR` or `CLICOLOR_FORCE` turns color on, even when output isn't a terminal

## JSON output

With `--json`, aireg prints one JSON object per line on stdout, in one shape for every command:

```json
{"ok": true, "data": {}}
```

`data` holds the command's result. Each command page describes its `data`, and every command publishes it as a JSON Schema in [`cli/schema/output`](https://github.com/atlanai/ai-registry/tree/main/cli/schema/output), one document per command with an entry per action, which the npm package ships too. A failure prints `ok: false` and an `error` with its code, message and hint:

```json
{"ok": false, "error": {"code": "usage", "message": "Unknown config action \"frob\".", "hint": "Use list, get, set or path."}}
```

A failure that came from a registry's adapter also names the `adapter`, and a `trace` id when the registry sent one.

Every command's `data` follows the same rules, so a script learns them once:

- `data` is always an object. A list is a field in it, such as `{"targets": [...]}`.
- A field that names a [target](targets.md) is `target`, or `targets` for several, and holds its id, such as `claude-code`, never an alias. Where aireg 0.1 printed such a field as `harness` or `harnesses`, that field is printed beside it too, with the id aireg 0.1 knows, such as `claude`. The earlier field is kept for compatibility and will be removed in a later release. A dangling link in [`aireg status`](status.md#json-output) keeps the shape aireg 0.1 printed.
- `registry` is a registry's name, as in `acme/engineering/pr-review`, and `address` is where the registry lives: a URL, a git address or a folder. The one exception is [`aireg search`](search.md), where each match's `address` is the artifact's full name, such as `acme/engineering/skill/pr-review`.
- A command that takes `--dry-run` has a `dryRun` field, `true` on a dry run and `false` otherwise. A dry run fills the same fields a real run does, with what the command would do.
- A command prints one JSON document, except `aireg logs --follow` and `aireg job runs --follow`, which print one per line as entries arrive.

## Error codes

`code` is stable, so a script can branch on it rather than on the message:

| Code | Exit | Meaning |
|---|---|---|
| `usage` | `2` | The command line can't run as typed. |
| `not_found` | `1` | A registry, artifact, job or file doesn't exist. |
| `unauthorized` | `4` | A registry needs you to sign in, or refused the credential. |
| `forbidden` | `4` | You are signed in, but not allowed to do this. |
| `conflict` | `1` | What the command would create or remove clashes with what is there: a manifest, artifact, version or folder that already exists, a registry or account still in use, an `AIREG_TOKEN_<NAME>` already set, or a change another aireg process made meanwhile. |
| `changed` | `3` | Something differs from what was recorded or published: an artifact has local edits, or an edit was made on an older version than the one now published. |
| `busy` | `1` | Another aireg process is writing to this project or your user scope. See [`aireg unlock`](unlock.md). |
| `invalid` | `1` | A file, such as a manifest, lockfile or registry document, is not valid. |
| `integrity` | `1` | Downloaded content doesn't match its digest. |
| `unavailable` | `1` | A registry or git host couldn't be reached, or timed out. |
| `error` | `1` | Any other failure. |

`--json` also turns off questions and the text output. Warnings and hints still go to stderr.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | An error, such as a registry that can't be read or a name that doesn't exist. |
| `2` | A usage error: an unknown command, action or option, an option the command doesn't take, a missing, extra, invalid or ambiguous argument or option value, or a command run where it can't run, such as outside a project. |
| `3` | Changes found: what is installed doesn't match what was recorded, or would change. See below. |
| `4` | A registry refused access, and you need to sign in to it. |

When an unknown command, action or option is close to a real one, the hint names it, as in ``hint: Did you mean `aireg install`?``.

Exit code 3 lets a script check for changes without parsing output. These commands return it:

| Command | Returns 3 when |
|---|---|
| [`aireg status`](status.md) | An installed artifact is missing, replaced or edited. |
| [`aireg outdated`](outdated.md) | Something that isn't pinned has a newer version, or a registry couldn't be checked. |
| [`aireg sync`](sync.md) | Something needs your attention. |
| [`aireg add`](add.md), [`remove`](remove.md), [`install`](install.md) or [`update`](update.md) with `--frozen` | It would change the lockfile or the manifest. |
| [`aireg publish`](publish.md) | An edit was made on an older version than the one now published. |
| [`aireg remove`](remove.md) | An artifact has local edits and `--force` wasn't passed. |

For example, to fail when a project's installs have changed:

```bash
aireg install --frozen && aireg status
```

## See also

[CLI reference](index.md)
