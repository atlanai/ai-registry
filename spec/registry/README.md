# Future: a registry server

**Status:** notes on a future implementation. Nothing here is a requirement, and nothing here is implemented.

The [file spec](../file-spec.md) is complete for reading: a directory, a git repository, or an HTTPS root is a registry a client can read and verify on its own. A server is what adds writing and everything that needs state across many artifacts. These notes record what a server would add and the one rule already decided about it, so the file spec can stay small.

## The one rule

A server serves the file spec's paths unchanged: `{root}/registry.json`, `{root}/index.json`, `{root}/artifacts/…`, `{root}/blobs/…`. A client that speaks the file spec over HTTPS works against a server without knowing it is one. Anything a server adds lives beside those paths, never instead of them.

## What a server would add

| Capability | What it means | Why the file spec does not have it |
|---|---|---|
| Publish | upload files by digest, then append a version, validating digests and writing `versions.json` and `index.json` | a repository root publishes through a pull request that carries what the indexer wrote, checked by the validator in CI |
| Catalog state | move a version through its lifecycle | a repository root edits `versions.json` through a pull request |
| Search | full-text and vector search over the index with filters and facets | a client searches `index.json` offline |
| Remotes | federate another root: index, proxy, or mirror it, and map its namespaces into local ones | a client links several roots itself |
| Governance | gated kinds, scan and evaluation runs, approvals, audit | out of scope for files |
| Telemetry | ingest traces that name artifacts | a different plane entirely |

## Questions a server design must answer

- The publish path and body shape, and how a client polls `versions.json` until a version appears.
- The lifecycle edge list and which transition needs which permission.
- The error catalog shape, the permission vocabulary, and roles at the namespace.
- How remotes mount namespaces, and how trust in remote content is established.

## Related

A server built from these notes would implement the [file spec](../file-spec.md); these notes are not a contract it can be held to.
