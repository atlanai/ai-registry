# aireg status

Check installed artifacts against the lockfile, and list the ones nothing manages.

## Synopsis

```text
aireg status [-g]
```

## Description

`aireg status` checks each artifact the lockfile records against what is on disk, without contacting any registry. Outside a project it checks your user scope. Each artifact gets one state:

| State | Meaning |
|---|---|
| `ok` | Installed as the lockfile records it. |
| `missing` | The stored copy, or a link in a harness folder, is missing, or something else holds the path the link needs. |
| `replaced` | A harness link was replaced by a file or folder of yours, or points outside the scope. `--json` calls this state `dangling`. |
| `edited` | The installed copy was edited after it was installed. With `--copy`, that includes the copy in the harness folder. |

The table shows each artifact's kind, version and registry, then a column per harness it was installed for: `✓` when linked where that harness reads it, `missing`, `replaced`, `foreign` when its link points outside the scope, or `-` when it isn't installed there. A version marked `pinned` is held by the manifest.

Lines under the table explain each `-` and, when something needs attention, what `ok` means.

`status` ends with what to run next. Run [`aireg install`](install.md) to restore missing or replaced artifacts, which first moves a file or folder of yours that replaced a link to `.registry/backups/`, and [`aireg sync`](sync.md) to compare an edit with the registry.

A link aireg did not make is `missing` too, with the reason: a folder of yours already at the path, or another artifact of the same name installed there. `install` leaves your folder alone, so move it. When another artifact holds the path, `aireg install` with `defaults.name-collision` set to `rename`, the default, installs this one under its namespace and name.

Below the table, `status` lists the unmanaged artifacts: skills and agents in your harness folders that aireg didn't install. A link of yours counts, such as a skill kept in one folder and linked into each harness: it is listed once, with every harness that holds it or links it, at the real folder's path. So does an agent in a harness's own format, such as a Codex `.toml` agent, though `aireg publish` takes its Markdown file instead. Publish one to a registry to manage it, with [`aireg publish`](publish.md). [`aireg sync`](sync.md) still never adopts a link of yours, since whoever made it owns what it points at.

After that, `status` lists the dangling links in your harness folders: links of yours whose target is gone, which the harness cannot load. Remove one with `rm`. A link aireg made that lost its target is reported as `missing` in the table instead.

In a project, `status` also warns about an artifact installed in both the project and your user scope, because your harness decides which one it loads.

## Options

`status` takes `-g`, to check your user scope. See [Command options](options.md#command-options).

## JSON output

```json
{"ok": true, "data": {
  "scope": "project",
  "artifacts": [{"name": "engineering/pr-review", "state": "ok", "harnesses": {"agents": "linked", "claude": "linked"}, "needsApproval": [{"harness": "tool", "run": "tool trust"}]}],
  "shadowed": [],
  "unmanaged": [{"name": "lint", "kind": "skill", "harnesses": ["claude"], "path": "/home/me/project/.claude/skills/lint"}],
  "dangling": [{"path": "/home/me/project/.claude/agents/old.md", "target": "/home/me/agents/old.md", "harness": "claude"}]
}}
```

In JSON, `harnesses` is keyed by folder, and a value is `linked`, `missing`, `replaced` or `foreign`. `state` uses `dangling` for what the table calls `replaced`. An artifact that isn't `ok` also has a `detail` saying why, starting with the folder. `shadowed` names the artifacts installed both here and in your user scope, which the warning above is about; it is always empty for `-g`. `dangling` gives each dangling link's path, the target it names, as written, and its harness. `needsApproval` lists each harness that loads the artifact only after a [trust step](harnesses.md#trust-and-reload-steps), with the command to run; aireg never runs it.

## Exit status

- `0`: every artifact is `ok`, or nothing is installed. Unmanaged artifacts don't change the exit status.
- `2`: an argument was given.
- `3`: at least one artifact is `missing`, `replaced` or `edited`.

## Examples

Check this project:

```bash
aireg status
```

```text
1 installed in this project
  artifact   kind   version  from  Claude Code  Codex  state
  pr-review  skill  0.1.0    acme  ✓            ✓      ok

✓ Everything matches the lockfile.
```

Check your user scope:

```bash
aireg status -g
```

Fail if anything installed in the project is out of date or was edited:

```bash
aireg install --frozen && aireg status
```

## See also

[`aireg list`](list.md), [`aireg install`](install.md), [CLI reference](index.md)
