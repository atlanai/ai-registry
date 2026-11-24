# acme-registry

A complete file-spec root in one directory. Two kinds, one namespace, one blob, and every digest real. Clone it as a repository and it is a registry; read it from disk and it is a registry. Served from a static file host it is a registry under the file spec too, though no client reads an HTTPS root yet: aireg reads folders and git repositories.

```
registry.json                                        discovery: kind registry, slug acme
index.json                                           catalog
artifacts/engineering/skill/pr-review/versions.json  two versions
artifacts/engineering/skill/pr-review/1.1.0/         deprecated; SKILL.md only
artifacts/engineering/skill/pr-review/1.2.0/         active; adds references/checklist.md inline and assets/rubric.json in the blob store
artifacts/engineering/agent/reviewer/versions.json
artifacts/engineering/agent/reviewer/0.3.0/          depends_on engineering/skill/pr-review@1.2.0
blobs/sha256/28eb…fc0c                               the rubric bytes
kinds/skill.json, kinds/agent.json                   the manifests registry.json advertises
```

Two identifiers are at work and they are not the same one. The root belongs to the `acme` organization, which is `slug` in `registry.json` and never appears in a path. `engineering` is a namespace inside that root: a team workspace, one of several the organization could hold. A registry with a single team is tempted to give both the same name; this example keeps them distinct so the layout still reads correctly when a second namespace arrives.

`registry.json` omits `url` because a directory has no fixed address; a root served over HTTPS sets it.

## Two round trips

A client resolving `engineering/skill/pr-review`:

1. Read `artifacts/engineering/skill/pr-review/versions.json`. `latest` is `1.2.0`; the entry carries the content digest.
2. Read `artifacts/engineering/skill/pr-review/1.2.0/artifact.json`. Verify its canonical form hashes to that digest. Read `files[]`.
3. Fetch `SKILL.md` and `references/checklist.md` from the version directory, and `assets/rubric.json` from `blobs/sha256/<digest>` because its descriptor has no `urls`. Verify each against its digest and size.

The agent's envelope names the skill in `relationships[]`, so installing the agent pulls the skill the same way.

## Checking it

```
python3 tools/check.py examples/acme-registry
```

recomputes every digest and checks that `index.json` and both `versions.json` agree with the version directories. In a repository root those two documents are written by the indexer, `aireg registry index`; the one hand edit they take is a status change in `versions.json` ([file spec](../../spec/file-spec.md) section 9). `python3 tools/check_schemas.py` additionally validates every document here against [`spec/schemas/`](../../spec/schemas/README.md).

`kinds/` holds the manifests this root advertises in `registry.json`, so `manifest_url` resolves inside the root and the directory stays self-contained. They are copies of `spec/schemas/kinds/`, and `tools/check.py` fails if the bytes drift apart.
