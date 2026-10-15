# aireg watch

Publish a folder's skills and agents whenever they change.

## Synopsis

```text
aireg watch add <folder>... --to <registry>/<namespace> [-g]
aireg watch remove <folder>... [-g]
aireg watch list
```

`aireg watch` on its own runs `aireg watch list`.

## Description

A watched folder is one you write skills or agents in, such as `~/.claude/skills`. In the background, aireg copies what changed in it and publishes it to the registry as the next version, the way [`aireg publish`](publish.md) would. It never moves or deletes your files, unless you settle a conflict with `aireg sync resolve --theirs`, which first moves your copy to `.registry/backups/`.

A watch belongs to a scope: a project, or with `-g` your user scope. It is part of the [job](job.md) that keeps that scope in sync with the registry, since a publish first pulls what the registry has, so an edit never goes out over a newer version someone else published. Adding a watch therefore updates that job, and creates it if the scope has none. Removing a watch keeps the job, so what you installed stays up to date.

## aireg watch add

Publishes each `<folder>` to `--to` whenever it changes. The registry must already be declared in the scope; see [`aireg registry add`](registry.md#aireg-registry-add). A git registry is refused, since aireg doesn't push to git.

A scope's watched folders all publish to one place. A folder for another `<registry>/<namespace>` is refused, naming where the scope already publishes; to move them, remove those watches first.

The same as `aireg job add --watch <folder> --to <registry>/<namespace>`; use [`aireg job add`](job.md#aireg-job-add) for its other options, such as `--interval` or `--publish`.

| Option | Description |
|---|---|
| `--to <registry>/<namespace>` | Where the folder publishes. |
| `-g` | Watch it for your user scope. |

## aireg watch remove

Stops publishing each `<folder>`, and forgets the copies aireg kept of what it holds, in the scope's lockfile and `.registry/artifacts/`. Your folder stays as it is, and what was published stays in the registry. The scope's job keeps it in sync; once it watches no folder, it is again the job [`aireg add`](add.md) starts, which reports edits made here rather than publishing them.

A folder the scope doesn't publish is refused, naming the scope that does when there is one. `rm` is the same command.

| Option | Description |
|---|---|
| `-g` | Stop watching it for your user scope. |

## aireg watch list

Lists every watched folder on this machine: the folder, where it publishes, the job and its scope, with a project named by its folder. `ls` is the same command.

## JSON output

| Action | `data` |
|---|---|
| `add` | `{"job": {...}, "revision": 4}`, as for `job add` |
| `remove` | `{"jobId": "job_skills_acme", "watching": []}`, the folders the job still watches |
| `list` | `{"watches": [{"folder": "/home/me/.claude/skills", "to": "acme/engineering", "jobId": "job_skills_acme", "scope": "user", "root": "/home/me/.registry"}]}`: `scope` is `user` or `project`, and `root` is that scope's folder |

## Exit status

- `0`: success.
- `1`: the registry isn't declared, or the daemon didn't start.
- `2`: the action is unknown, no folder was named, `--to` is missing or isn't `<registry>/<namespace>`, `--to` names a registry that takes no publishes or isn't where the scope already publishes, or `remove` names a folder the scope doesn't publish.
- `4`: the registry needs a sign-in and there is no account signed in to it; run `aireg auth login <registry>` first.

## Examples

Publish the skills you keep in Claude Code to a team registry:

```bash
aireg registry add ../acme-registry -g
aireg watch add ~/.claude/skills --to acme/engineering -g
```

Stop publishing them, and keep what you installed up to date:

```bash
aireg watch remove ~/.claude/skills -g
```

## See also

[`aireg job`](job.md), [`aireg publish`](publish.md), [`aireg sync`](sync.md), [CLI reference](index.md)
