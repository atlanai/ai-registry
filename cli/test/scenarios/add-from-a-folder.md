---
registries:
  kit: [kit/lint@1.0.0, kit/lint@1.1.0, kit/deploy@1.0.0]
dirs: [.claude]
files:
  "[ROOT]/lone/notes.md": "Not a registry."
---

# A folder inside a registry adds that one artifact

A version folder declares the registry above it and pins the artifact to that version.

```console
$ aireg init -y
...
$ aireg add ../kit/artifacts/kit/skill/lint/1.0.0 -y
...
$ aireg list
1 installed in this project
  artifact  kind   version       from  harnesses
  lint      skill  1.0.0 pinned  kit   Claude Code, Codex
```

The manifest records the registry as typed, relative to the project, and the pin.

```file .registry/manifest.yml
...
registries:
  kit: ../kit
...
  - kit/kit/skill/lint@1.0.0
...
```

An artifact folder adds the newest version, under the registry already declared.

```console
$ aireg add [ROOT]/kit/artifacts/kit/skill/deploy -y
...
$ aireg list
2 installed in this project
  artifact  kind   version       from  harnesses
  deploy    skill  1.0.0         kit   Claude Code, Codex
  lint      skill  1.0.0 pinned  kit   Claude Code, Codex
```

A folder no registry holds, or one that names no artifact, is refused.

```console
$ aireg add [ROOT]/lone
? 2
error: No registry.json in [ROOT]/lone or any folder above it.
  code: usage
hint: Name a folder inside a registry, such as <registry>/artifacts/<namespace>/<kind>/<name>.
$ aireg add ../kit/artifacts/kit
? 2
error: ../kit/artifacts/kit is inside the registry at [ROOT]/kit, but names no artifact.
  code: usage
hint: Name an artifact's folder, artifacts/<namespace>/<kind>/<name>, or a version folder inside it.
```
