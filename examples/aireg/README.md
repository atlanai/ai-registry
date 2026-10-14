# ai-registry

The skills an agent needs to work with registries through the aireg CLI, published as a
registry of their own. It was made with the CLI it documents, the way any registry is:
`aireg registry init`, `aireg skill new` in `artifacts/aireg/`, then
`aireg registry index`.

```
registry.json                                      slug ai-registry
index.json
artifacts/aireg/skill/aireg-new/0.2.0/SKILL.md     set up a registry: create it, add skills, release, gate pull requests, hand it over
artifacts/aireg/skill/aireg-add/0.1.1/SKILL.md     find, read, install and update from a registry, and check installs in CI
artifacts/aireg/skill/aireg-publish/0.1.1/SKILL.md publish a skill, release its next version, or publish a project's skills from CI
```

Give an agent the skills in your user scope, so every harness on your machine has them. In
Claude Code they appear as `/aireg-new`, `/aireg-add` and `/aireg-publish`, and in Codex as
`$aireg-new` and so on. `aireg doctor` says whether they are installed. The `new`, `add` and
`publish` they replace are archived.

```sh
aireg registry add github.com/atlanai/ai-registry --path examples/aireg -g
aireg add ai-registry/aireg -g
```

To change a skill, start its next version with `aireg skill bump <name>`, edit that
folder, and run `aireg registry index`; `aireg registry validate` checks it.
