---
registries:
  kit: [kit/lint@1.0.0, kit/lint@1.1.0, kit/lint-fix@1.0.0, kit/deploy@1.0.0, agent kit/linter@1.0.0]
  tools: [tools/code-lint@2.0.0]
---

# Search finds artifacts across every registry the project declares

```console
$ aireg init -y
...
$ aireg registry add [ROOT]/kit --as kit
...
$ aireg registry add [ROOT]/tools --as tools
...
```

The exact name comes first, then names that start with the query, then names that contain it.

```console
$ aireg search lint
4 matches for "lint"
  name             kind   version  registry  description
  kit/lint         skill  1.1.0    kit       lint
  kit/lint-fix     skill  1.0.0    kit       lint-fix
  kit/linter       agent  1.0.0    kit       linter
  tools/code-lint  skill  2.0.0    tools     code-lint
  next   aireg add kit/kit/lint
```

`--kind` and `--registry` narrow it.

```console
$ aireg search lint --kind agent
1 match for "lint"
  name        kind   version  registry  description
  kit/linter  agent  1.0.0    kit       linter
  next   aireg add kit/kit/linter
$ aireg search lint -r tools
1 match for "lint"
  name             kind   version  registry  description
  tools/code-lint  skill  2.0.0    tools     code-lint
  next   aireg add tools/tools/code-lint
```

`--json` gives each match its full address.

```console
$ aireg search deploy --json
{
  "ok": true,
  "data": {
    "query": "deploy",
    "matches": [
      {
        "address": "kit/kit/skill/deploy",
        "registry": "kit",
        "namespace": "kit",
        "kind": "skill",
        "name": "deploy",
        "version": "1.0.0",
        "description": "deploy"
      }
    ],
    "skipped": []
  }
}
```

Nothing matching is not an error.

```console
$ aireg search nothing-like-it
No artifacts match "nothing-like-it".
hint: Run `aireg registry show <registry>` to see everything a registry publishes.
```

A search needs words, and a kind aireg knows.

```console
$ aireg search
? 2
error: `aireg search` needs something to search for.
  code: usage
hint: Name it: `aireg search <query>`, such as `aireg search review`.
$ aireg search lint --kind widget
? 2
error: --kind takes plugin, skill or agent, not "widget".
  code: usage
hint: Run `aireg search --help` for the options it takes.
```
