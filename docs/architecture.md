# Architecture

A registry is a set of files: the artifacts themselves and the metadata files that describe the registry and each artifact. Clients read a registry as files. A catalog API is planned, to add governance and federation across registries.

Refer to the [file spec](https://github.com/atlanai/ai-registry/blob/main/spec/file-spec.md) for more detail.

<figure markdown="span">
  ![A registry's files, laid out by the file spec and kept on any storage, are read directly by clients: the aireg CLI today and an MCP server later. A planned catalog API would create, federate, and govern registries and would not serve reads](assets/system.svg)
</figure>

## The file spec

Clients read a registry as files. The file spec defines their layout, so a folder, a git repository, or an object storage bucket holding those files is a complete registry. Agents read artifacts from the file system, not from a server. aireg reads folders and git repositories; no client reads an HTTPS root yet.

<figure markdown="span">
  ![Anatomy of a registry root: registry.json, index.json, an optional kinds directory, the artifacts directory with its namespace, kind, name, versions.json and version folders, and the blobs directory](assets/anatomy.svg)
</figure>

### Anatomy of a registry

A registry that follows the specification is a root (a directory, a git repository, or an HTTPS origin) that contains the components below. Each path is relative to a root.

- **`registry.json`.** The discovery document. It describes the registry itself: the format version it follows, its name and slug, its URL when it has one, how to authenticate, where blobs live, and the kinds of artifacts it contains. A **kind** is simply a type of artifact, such as `skill` or `agent`.
- **`index.json`.** The catalog. One entry per artifact in the registry, with its latest version, digest, and status, so a client can browse or search the registry in one read.
- **`artifacts/` directory.** Every artifact lives here, each in its own directory.
    - Each artifact's path has the form `<namespace>/<kind>/<name>/<version>`, for example the engineering team's pr-review skill (v1.2.0) would be stored in `engineering/skill/pr-review/1.2.0/`.
    - A **namespace** is the owner inside the root: a team, a workspace, or a GitHub owner, such as `engineering/`.
    - Each artifact directory contains a `versions.json` file, which lists the artifact's versions, names which one is latest, and holds each version's status. It is the only file about a version that changes after publish.
    - Each version has its own folder, which never changes after publish. It holds the artifact's own files, such as `SKILL.md` for a skill, and an `artifact.json` file with the metadata for that version: its identity, the files it contains with a digest for each, the kind's own `spec`, and its relationships to other artifacts in the registry.
- **`kinds/` directory (optional).** Where a root keeps the manifests that `registry.json` points to, one JSON Schema per kind, such as `skill.json` and `agent.json`. The manifests can live anywhere `registry.json` can reach.
- **`blobs/` directory.** Content stored once by its sha256 digest, for files that are large or shared between versions. A file listed in `artifact.json` without a URL is fetched from here.

Together, a registry looks like this:

```text
registry.json                                # discovery: kind, format_version, name, slug, capabilities, url, auth, blob_url, kinds[]
index.json                                   # catalog: every artifact with its latest version, digest, status

artifacts/                                   # every artifact lives here and nothing else does
  <namespace>/                               # the owner inside this root: a workspace, a team, a GitHub owner
    <kind>/                                  # skill or agent
      <name>/
        versions.json                        # one entry per version: digest, status, yanked; names latest
        <version>/
          artifact.json                      # the envelope: metadata, files[] with digests, spec, relationships[]
          SKILL.md                           # the kind's native files, byte-identical to what the author wrote
          references/...

kinds/                                       # optional: the manifests registry.json points to
  skill.json
  agent.json

blobs/
  sha256/
    <64 hex>                                 # large or shared content; descriptors without urls resolve here
```

## Clients

### aireg CLI

[aireg](https://github.com/atlanai/ai-registry/tree/main/cli), the CLI in this repository, creates registries, publishes to them and installs from them, and keeps installed artifacts in sync with harnesses like Claude Code and Codex. See [Quickstart](quickstart.md) and [Use cases](use-cases/teams.md) to get started.

### MCP server

An MCP server is also planned, so agents will be able to read a registry's artifacts directly with nothing installed.

## Concepts

**Root.** The place relative paths resolve from: a directory, a git repository, or an HTTPS origin with an optional prefix. One root is one registry, and it belongs to one organization.

**Namespace.** The owner inside a root: a team, a workspace, or a GitHub owner. It is the first segment of every ref.

**Artifact.** A named thing in a registry, identified everywhere by its ref. Each version is an envelope that wraps the artifact's native files unchanged and adds identity, a digest per file, the kind's `spec`, and outbound relationships.

**Kind.** The type of an artifact, such as `skill` or `agent`; `mcp_server` is planned. Each kind is declared by a manifest, a JSON Schema for `spec` with `x-registry-` keywords naming the files the kind requires and the edges it may declare. Relationship restrictions and search or governance annotations are not enforced by the CLI. `registry.json` lists the kinds a root holds. A kind wraps a format that already exists, such as `SKILL.md`, `AGENT.md`, an A2A card, or the MCP registry's `server.json`, and never invents a second one. The registry grows by adding a manifest, not by changing the format. See the [kind manifests](https://github.com/atlanai/ai-registry/tree/main/spec/schemas/kinds).

**Version and ref.** `namespace/kind/name@version`, for example `engineering/skill/pr-review@1.2.0`. Without `@version` a ref resolves to `latest`. Semantic versioning is recommended and is required for range resolution.

**Status.** One of `draft`, `pending_review`, `active`, `blocked`, `deprecated`, `archived`, held in `versions.json`. `yanked` is a separate flag. A pinned install keeps resolving after a deprecation or a yank. aireg warns that the version it keeps is yanked whenever it reads the registry to install, update or sync; an `install` with everything already in place reads no registry, so it says nothing.

**Content digest and catalog digest.** The content digest identifies the bytes of a version and never changes. The catalog digest identifies the version plus its mutable state and moves when that state does. See [Digests](https://github.com/atlanai/ai-registry/blob/main/spec/file-spec.md#4-digests).

**Relationship.** An outbound edge from one version to another ref: `depends_on` or `supersedes`. Installing an agent resolves its `depends_on` closure.

**Publisher.** The one writer of a registry's pointer files. In a repository, whoever runs `aireg registry index`, by hand or in CI.

**Client.** Anything that reads a registry: the aireg CLI, an MCP server, a CI job, or a harness.

**Host document.** What `/.well-known/registry.json` returns when a host serves several roots: the roots the caller may see, and how to authenticate. See [Host discovery](https://github.com/atlanai/ai-registry/blob/main/spec/file-spec.md#8-host-discovery).
