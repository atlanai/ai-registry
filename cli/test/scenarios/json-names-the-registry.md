---
registries:
  kit: [kit/lint@1.0.0, kit/deploy@1.0.0]
dirs: [.claude]
---

# `--json` names the registry and the version of what it installed

```console
$ aireg init -y
...
$ aireg registry add [ROOT]/kit --as kit
...
$ aireg add kit --all -y
...
$ aireg list --json
{
  "ok": true,
  "data": {
    "scope": "project",
    "artifacts": [
      {
        "name": "kit/deploy",
        "shown": "deploy",
        "kind": "skill",
        "registry": "kit",
        "address": "[ROOT]/kit",
        "ref": "1.0.0",
        "pinned": false,
        "targets": [
          "agents",
          "claude"
        ]
      },
      {
        "name": "kit/lint",
        "shown": "lint",
        "kind": "skill",
        "registry": "kit",
        "address": "[ROOT]/kit",
        "ref": "1.0.0",
        "pinned": false,
        "targets": [
          "agents",
          "claude"
        ]
      }
    ]
  }
}
$ aireg registry list --json
{
  "ok": true,
  "data": {
    "scope": "project",
    "registries": [
      {
        "registry": "kit",
        "address": "[ROOT]/kit",
        "config": {}
      }
    ]
  }
}
$ aireg registry show kit --json
{
  "ok": true,
  "data": {
    "registry": "kit",
    "address": "[ROOT]/kit",
    "layouts": [
      "local"
    ],
    "entries": [
      {
        "name": "deploy",
        "kind": "skill",
        "namespace": "kit",
        "path": "artifacts/kit/skill/deploy",
        "description": "deploy",
        "version": "1.0.0"
      },
      {
        "name": "lint",
        "kind": "skill",
        "namespace": "kit",
        "path": "artifacts/kit/skill/lint",
        "description": "lint",
        "version": "1.0.0"
      }
    ],
    "warnings": []
  }
}
$ aireg show kit/skill/lint --json
{
  "ok": true,
  "data": {
    "name": "lint",
    "kind": "skill",
    "version": "1.0.0",
    "body": "---\nname: lint\ndescription: lint\n---\n\n# lint\n",
    "carries": []
  }
}
```

A mistyped command is a usage error a script can branch on.

```console
$ aireg instal --json
? 2
{
  "ok": false,
  "error": {
    "code": "usage",
    "message": "[..]",
    "hint": "[..]"
  }
}
```
