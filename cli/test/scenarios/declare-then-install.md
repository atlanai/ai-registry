---
registries:
  kit: [kit/lint@1.0.0, kit/deploy@1.0.0]
dirs: [.claude]
---

# Declaring a registry installs nothing until you add from it

```console
$ aireg init -y
...
$ aireg registry add [ROOT]/kit --as kit
...
```

The manifest records the alias, and nothing is locked or linked yet.

```file .registry/manifest.yml
...
registries:
  kit: [ROOT]/kit
...
artifacts: []
```

!file .registry/manifest.lock.yml
!file .claude/skills/lint

```console
$ aireg registry list
1 registry in this project
  name  address[..]installs
  kit   [ROOT]/kit  nothing
$ aireg registry show kit
kit
  address    [ROOT]/kit
  layout     local
  artifacts  2

  artifact    kind   description
  kit/deploy  skill  deploy
  kit/lint    skill  lint
```

Adding from the alias installs what it publishes.

```console
$ aireg add kit --all -y
...
$ aireg list
2 installed in this project
  artifact  kind   version  from  targets
  deploy    skill  1.0.0    kit   Claude Code, Codex
  lint      skill  1.0.0    kit   Claude Code, Codex
```
