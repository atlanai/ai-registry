# File spec

**Status:** normative, draft v0.1 · **Format version:** 1

The file spec says how a registry is laid out as files. A directory, a git repository, or an HTTPS root that follows it is a complete registry that any client can read. There is no server in this specification; a server is a [future addition](registry/README.md) that serves these same files and adds writing on top.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as described in RFC 2119 and RFC 8174.

## 1. Roots

A **root** is the place relative paths resolve from. Every path in this document is relative to a root, and the same paths work for all three kinds of root.

| Root | Example | How a client reads a path |
|---|---|---|
| directory | `/Users/me/src/my-registry` | the file system |
| git repository | `https://github.com/acme/skills` | a clone, or the host's raw-file URL for the path |
| HTTPS root | `https://registry.example.com/acme` | `GET {root}/<path>`; see section 7 |

An HTTPS root is an origin plus an optional path prefix, written without a trailing slash. The prefix is opaque: a client MUST NOT parse it, split it, or infer anything from it. `https://registry.example.com`, `https://registry.example.com/acme`, and `https://acme-registry.example.com` are all roots.

A root is single-tenant by construction. A host that serves several organizations serves several roots, each a complete registry, and nothing in this document spans two roots. How a client that reads several roots stores them locally is the CLI's concern, [`cli/storage-spec.md`](../cli/storage-spec.md).

## 2. Layout

```
registry.json                                # discovery: kind, format_version, name, slug, url, auth, blob_url, kinds[]
index.json                                   # catalog: every (namespace, kind, name) with latest version, digest, status

artifacts/                                   # every artifact lives here and nothing else does
  <namespace>/                               # the owner inside this root: a workspace, a team, a GitHub owner
    <kind>/                                  # skill, agent, mcp_server, …
      <name>/
        versions.json                        # one entry per version: version, digest, catalog_digest, published_at, status, yanked
        <version>/
          artifact.json                      # the envelope: apiVersion, kind, metadata, files[], spec, relationships[]
          SKILL.md                           # the kind's native files, byte-identical to what the author wrote
          references/…

blobs/
  sha256/
    <64 hex>                                 # large or shared content; descriptors without urls resolve here
```

Four root entries have meaning in format 1: `registry.json`, `index.json`, `artifacts/`, and `blobs/`. A reader MUST ignore any other root entry (`README.md`, `.nojekyll`, `.git`, a future document). Because artifacts are mounted under `artifacts/`, no namespace name is reserved.

The example at [`examples/acme-registry`](../examples/acme-registry) is a complete registry in this layout.

### 2.1 Path grammar

| Segment | Grammar | Notes |
|---|---|---|
| `namespace` | `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` | lowercase, DNS-label-like, 1 to 64 characters |
| `kind` | `^[a-z][a-z0-9_]{0,31}$` | lowercase identifier |
| `name` | `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` | same grammar as namespace |
| `version` | `^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$` | `latest` is reserved and MUST be rejected as a version |

A version string is required. Semantic versioning SHOULD be used; range resolution by a client is defined only for versions that parse as semver. The digest, not the version string, is the truth about content. Whether semver is required rather than recommended is open.

Path segments are case-sensitive. A registry MUST NOT contain two artifacts whose paths differ only by case.

A segment MUST NOT be a name Windows reserves for a device: `con`, `prn`, `aux`, `nul`, `com1` to `com9` or `lpt1` to `lpt9`, in any case and with or without an extension. A registry is checked out as folders, and Windows cannot create these.

### 2.2 The fully qualified reference

An artifact version is identified everywhere by its ref:

```
<namespace>/<kind>/<name>@<version>
engineering/skill/pr-review@1.2.0
```

The ref's segments are the storage path's segments under the mount:

| | |
|---|---|
| ref | `engineering/skill/pr-review@1.2.0` |
| path | `artifacts/engineering/skill/pr-review/1.2.0/` |
| URL | `https://registry.example.com/acme/artifacts/engineering/skill/pr-review/1.2.0/artifact.json` |

A ref without `@<version>` resolves to the `latest` field of the versions document.

On a hosted root the namespace is whatever partition the host gives its members, such as a team or a person. On a repository root it is whatever partition the owner chooses, conventionally the repository owner.

### 2.3 File paths

A `files[].path` names a file inside the version directory, relative to it, with `/` between segments. A path MUST be written so that every platform stores it inside that directory:

- It is not empty and does not start with `/`.
- No segment is empty, `.` or `..`.
- It contains no backslash, no `:` (a drive letter or a Windows alternate data stream), and no control character (U+0000 to U+001F and U+007F to U+009F).
- No segment is one a file system stores as `.git`, which would make the version directory a repository. Segments are compared after removing the code points HFS+ ignores (U+200C to U+200F, U+202A to U+202E, U+206A to U+206F, U+FEFF), lowercasing, and removing trailing dots and spaces, and the 8.3 short name `git~1` counts as `.git`.

Two paths of one version MUST NOT be equal after Unicode NFC normalization and lowercasing, and no path may sit under another path of the version compared the same way, because a case-insensitive disk stores them as one file. A reader MUST refuse an envelope that breaks these rules rather than skip the offending file.

## 3. Documents

Each document below has a JSON Schema 2020-12 file in [`schemas/`](schemas/). The schemas are
normative for shape: types, patterns, and which fields are required. This prose is normative for
meaning, and for the rules a schema cannot state: cross-document agreement, digest computation,
path agreement, and uniqueness. They describe one contract and MUST agree; a disagreement between
them is a defect in this repository.

### 3.1 `registry.json`

The discovery document at the root. Schema: [`schemas/registry.schema.json`](schemas/registry.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `kind` | SHOULD | `"registry"`. Distinguishes this from a host document (section 8). Absent means registry. |
| `format_version` | yes | integer; this document describes version 1 |
| `name` | yes | human-readable registry name |
| `description` | no | one or two sentences about the root, up to 4000 characters |
| `slug` | no | owner slug in namespace grammar: the slug the host gives the root on a hosted root, the repository owner on a repository root. Never appears in a path. |
| `url` | SHOULD on HTTPS roots | the canonical root, no trailing slash. A client keeps reading from the root it was given and records `url` as the registry's identity, so a mirror and its origin agree. A client MUST NOT follow `url` as a redirect. |
| `capabilities[]` | yes | what this root offers. A file root advertises `["files"]`. Other values are reserved for a future server. |
| `auth` | no | `{type: none}` or `{type: oauth2, resource_metadata, login_url?}`; see section 7 |
| `blob_url` | no | URI template containing `{digest}`; default `blobs/sha256/{digest}` |
| `kinds[]` | no | `{name, manifest_url}` per kind held. `manifest_url` is a URI reference; a relative one resolves against the root, so a root MAY serve its own manifests. The manifest format is open; the one this repository uses is [`schemas/kind-manifest.schema.json`](schemas/kind-manifest.schema.json) |
| `generated_at` | no | when the indexer last ran |
| `api_version` | no | kept for a future server; a file root omits it |

### 3.2 `index.json`

The catalog. An object with `format_version`, `generated_at`, and `entries[]`. Each entry carries `namespace`, `kind`, `name`, `latest`, `digest`, `status`, and optionally `catalog_digest`, `display_name`, `description`, `labels`, `updated_at`. Entries MUST be unique on `(namespace, kind, name)`. A client downloads it once and searches it offline. It is generated from the versions documents and MUST agree with them. Schema: [`schemas/index.schema.json`](schemas/index.schema.json).

### 3.3 `versions.json`

At `artifacts/<namespace>/<kind>/<name>/versions.json`. Schema: [`schemas/versions.schema.json`](schemas/versions.schema.json). An object with `namespace`, `kind`, `name`, `latest`, and `versions[]`; each version entry carries `version`, `digest`, `published_at`, `status`, `yanked`, and optionally `catalog_digest` and `reason`.

```json
{
  "namespace": "engineering", "kind": "skill", "name": "pr-review",
  "latest": "1.2.0",
  "versions": [
    { "version": "1.2.0", "digest": "sha256:7d1e…", "catalog_digest": "sha256:a0f3…",
      "published_at": "2026-09-01T10:12:00Z", "status": "active", "yanked": false },
    { "version": "1.1.0", "digest": "sha256:c2b9…", "catalog_digest": "sha256:55e1…",
      "published_at": "2026-08-14T09:00:00Z", "status": "deprecated", "yanked": false,
      "reason": "superseded by 1.2.0" }
  ]
}
```

`latest` MUST name a listed version. When any version is `active` and not yanked, `latest` MUST be the newest of those: by semver precedence where the versions parse as semver, with a release ahead of every prerelease, and with a version that does not parse ranking below every one that does. A version is kept from `latest` by its status, not by pointing `latest` at another version. Entries SHOULD be ordered newest first. `status` is one of `draft`, `pending_review`, `active`, `blocked`, `deprecated`, `archived`; which transitions are legal is a server concern and not defined here.

### 3.4 `<version>/artifact.json`

The envelope: a fixed header, an open `spec` the kind owns, the files the version carries, and its outbound relationships. Schema: [`schemas/artifact.schema.json`](schemas/artifact.schema.json), with the kind manifests applied to `spec` in [`schemas/artifact-known-kinds.schema.json`](schemas/artifact-known-kinds.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `apiVersion` | yes | `aireg.sh/v1`. Names the envelope, not the kind, and is fixed for format 1. An opaque token: nothing dereferences it |
| `kind` | yes | the artifact's kind, in the section 2.1 grammar. MUST equal the `<kind>` path segment. It is a sibling of `metadata`, not a field inside it |
| `metadata.name`, `.namespace`, `.version` | yes | MUST equal the path segments the file sits under |
| `metadata.display_name` | no | short title, up to 200 characters |
| `metadata.description` | no | up to 4000 characters |
| `metadata.status` | no | the status at publish, and informative only; `versions.json` is authoritative. Removed before the content digest is computed, so status moves without breaking a pin |
| `metadata.labels` | no | short indexable string pairs. Catalog state: covered by the catalog digest, not the content digest |
| `metadata.annotations` | no | free-form string pairs, never indexed. Catalog state, like labels |
| `metadata.source` | no | provenance: `{type: git \| upload \| remote \| generated, uri?, revision?}` |
| `metadata.created_at`, `.created_by` | no | publish time, and the subject that published. `created_by` is an opaque identifier and MUST NOT be an email address on a public root |
| `metadata.digest` | SHOULD | the content digest of section 4.2. An indexer fills it; an author MAY omit it in a pull request |
| `metadata.uid` | no | an identifier a hosted registry MAY mint. A client MUST NOT require it; the ref is the identity |
| `files[]` | yes | at least one file descriptor; see 3.5 and 4.1. Schema: [`schemas/file-descriptor.schema.json`](schemas/file-descriptor.schema.json) |
| `spec` | yes | the kind's own document, unchanged. Opaque to a reader by rule 4; validated against the kind manifest at publish |
| `relationships[]` | no | outbound edges `{rel_type, to, annotations?}`, where `to` is a fully qualified ref. Catalog state. Schema: [`schemas/relationship.schema.json`](schemas/relationship.schema.json) |

Writers MUST NOT invent header fields. Extension data belongs in `spec`, `labels`, or `annotations`.

For the kinds defined here, `spec.name` MUST equal `metadata.name`. A skill carries its parsed
`SKILL.md` front matter, with no additional fields beyond its schema; its name MUST NOT contain
consecutive hyphens and `compatibility`, when present, MUST contain 1–500 characters. An agent
carrying `AGENT.md` preserves its parsed native front matter, including tool-specific fields.
An agent carrying `agent-card.json` instead wraps that unchanged object in `spec.card`, copies
its description to `spec.description`, and uses the registry slug for `spec.name`. The card's
own `name` remains its human-readable name and need not equal the slug. An agent MUST carry
exactly one of these native entry files. Other supporting files are permitted; the optional
file patterns in a kind manifest are non-exhaustive conventions.

### 3.5 Native files

Every file named in `files[]` whose `urls` entry is a relative reference is stored at that path under the version directory, byte-identical to what the author wrote. The envelope wraps a kind's existing format; it never rewrites it.

### 3.6 `blobs/sha256/<hex>`

Content addressed by sha256. A descriptor without `urls` resolves through the `blob_url` template with `{digest}` replaced by the bare 64-hex digest. `blob_url` MAY be absolute and MAY name another host. Because the client verifies every byte against the descriptor's digest, the blob host is untrusted, and section 11 says what a client may send it.

## 4. Digests

Two digests exist per version, on purpose.

### 4.1 File digest

`files[].digest` is the sha256 of the file's bytes, written `sha256:<64 lowercase hex>`; `files[].size` is the byte length. A client MUST verify both before using a file.

### 4.2 Content digest

`digest`, in `versions.json` entries and `metadata.digest`, covers content and never changes. It is the sha256 of the RFC 8785 (JSON Canonicalization Scheme) serialization of the envelope as written, every field included, after removing `metadata.digest` and `metadata.status`. A reader computes it over the document it received, not over a copy rebuilt from the fields it knows. A client pins it.

To keep independent canonicalizers in agreement, an envelope MUST NOT contain non-integer numbers, and integers MUST be within ±(2^53 − 1). Text is UTF-8.

### 4.3 Catalog digest

`catalog_digest` covers the content digest plus mutable catalog state: the sha256 of the RFC 8785 serialization of

```json
{ "digest": "<content digest>", "status": "<status>", "yanked": <bool>,
  "labels": { … }, "annotations": { … }, "relationships": [ … ] }
```

with `labels` and `annotations` from `metadata` (empty objects when absent) and `relationships` from the envelope (empty array when absent). It moves when a version is relabeled, deprecated, yanked, or archived. The exact field set is open.

## 5. Rules

1. **Versions are immutable.** A version directory is written once. The only mutable fields live in `versions.json`: `status`, `yanked`, `reason`, and the `catalog_digest` that covers them. `metadata.status` inside `artifact.json` records the status at publish and is informative; `versions.json` is authoritative.
2. **Digests are the truth.** Every mirror, CDN, and blob store between the root and the client is untrusted; the client verifies what it receives against the root's documents. Format 1 does not authenticate the root itself: a client that reads a root trusts what that root says.
3. **Small files inline, large files in blobs.** A kind's readable files sit beside the envelope so a pull request stays reviewable. Content over a registry-level threshold, or shared across versions, is a descriptor without `urls`; the threshold is open.
4. **Unknown is not an error.** Readers MUST ignore unknown envelope fields, unknown kinds, unknown `spec` content, and unknown root entries. Writers MUST NOT commit a `format_version` they do not understand.
5. **Capabilities are advertised.** A client uses only what `registry.json` claims. No conformance suite exists yet; [`tools/check.py`](../tools/check.py) checks a file root's paths, documents, and digests.
6. **Writes to a repository root are pull requests.** An indexer generates `versions.json` and `index.json`. The one hand edit a pull request may make to them is a status change in `versions.json`, described in section 9.
7. **Nothing is erased.** Yanking or archiving changes state in `versions.json`; bytes stay resolvable to a pinned digest. Physical removal is an operator action outside the spec.

## 6. What a client reads

| To | Read | Then |
|---|---|---|
| learn what this root is | `registry.json` | check `format_version`, note `slug` and `url`, read `auth` |
| browse or search offline | `index.json` | filter by namespace, kind, label, status |
| resolve a ref | `artifacts/<ns>/<kind>/<name>/versions.json` | pick `latest` or the requested version; take its `digest` |
| get the entry | `artifacts/<ns>/<kind>/<name>/<version>/artifact.json` | verify its content digest equals the one from `versions.json` |
| get the bytes | each `files[]` descriptor: the relative URL under the version directory, or `blob_url` | verify digest and size |
| follow an edge | `relationships[]` in the envelope | resolve each `to` ref the same way |
| know which kinds exist | `registry.json` → `kinds[]` → each `manifest_url` | validate `spec` if you are a writer; readers treat `spec` as opaque |

Two round trips resolve a ref to bytes: the versions document, then the entry and the files it names.

## 7. Serving over HTTPS

An HTTPS root serves the same paths with `GET` and `HEAD`. Nothing else is required of it.

- **Content types.** `application/json` for `registry.json`, `index.json`, `versions.json`, and `artifact.json`; the descriptor's `media_type`, or `application/octet-stream`, for files and blobs.
- **Missing paths** answer 404. No body is required. A client treats a 404 on the deepest segment it asked for as "unknown".
- **Conditional requests** MAY be supported. `ETag` and `If-None-Match` save bandwidth; they carry no trust, because the client verifies digests anyway.
- **Private roots.** A root MAY require a token. Every path of such a root answers `401` with `WWW-Authenticate: Bearer resource_metadata="<url>"` (RFC 9728) until a valid `Authorization: Bearer` header arrives. `registry.json.auth` names the same resource metadata and, optionally, a `login_url` for interactive clients. A client MUST send a bearer token only after a challenge, only to the origin it was issued for (section 11), and MUST obtain it by OAuth 2.0 with PKCE at the authorization server the resource metadata names. A client MAY keep a token between runs in the operating system's credential store or in a file only the user can read and write, and MUST NOT read a token from a file that other users can read. Anonymous reading MUST remain possible for a public root.
- **Redirects.** A path MAY answer `307` to another URL, for example a presigned or CDN URL for a blob. The client follows it only as section 11 allows, and verifies the bytes it receives, wherever they came from.
- **Serving from a directory or repository.** GitHub Pages, GitHub raw, S3, and any static file server satisfy this section as they are. A Jekyll-based host leaves out paths that begin with `_` or `.`, and a file path may begin with either, so a root served from one needs a `.nojekyll` file.

## 8. Host discovery

A host may serve one root at its origin or many roots under prefixes. A client that is given only a host name learns which with one request:

```
GET https://{host}/.well-known/registry.json
```

The response is one of two documents, told apart by `kind`:

- a **registry document** (`kind: "registry"`, or absent): the origin itself is the root. Read on as section 6.
- a **host document** (`kind: "host"`): the host serves several roots. It carries `format_version`, `name`, `auth` for the host (same shape as in `registry.json`), optionally `description` and `generated_at`, and exactly one of `roots[]` that the caller may see or a `roots_url` whose response is `{items: [root], page: {next_cursor, size}}`. A document carrying both leaves a client no rule for which wins, so it MUST carry one. Schema: [`schemas/host.schema.json`](schemas/host.schema.json). Each root is `{slug, url, name?, role?}`: `slug` in namespace grammar and equal to that root's `registry.json.slug`, `url` the root without a trailing slash, `role` one of `viewer`, `member`, `admin` when the host chooses to disclose it. [`examples/host-document.json`](../examples/host-document.json) is one. Anonymous callers see public roots; a caller with a token sees the roots that token grants. The response MUST carry `Vary: Authorization` and MUST NOT be served to one principal from another's response.

Client algorithm, and nothing more is probed:

1. Given a URL with no path: GET the well-known document. Registry → the origin is the root. Host → complete the `auth` flow once for the host, GET the document again with the token, and read every root in `roots[]` through section 6.
2. Given a URL with a path: GET `{url}/registry.json`. It MUST be a registry document.

A hosted registry gives each organization one root, `https://{host}/<slug>`, where the slug is that root's `slug`. One token for the host covers every root the subject belongs to; a root not granted by the token answers `401` or `404` at the host's discretion. A host that serves several roots SHOULD NOT also serve a registry at its origin; if it does, a root's slug MUST NOT equal any root-level entry that registry serves, which is at least `artifacts`, `blobs`, `index.json`, and `registry.json`, and more when the root serves its own kind manifests. The host MUST refuse such slugs at creation.

The well-known path is origin-scoped by RFC 8615 and is served only at the host. A root with a path prefix does not have one; its discovery document is `{root}/registry.json`.

## 9. Publishing to a repository root

Publishing a version is a pull request that adds `artifacts/<ns>/<kind>/<name>/<version>/` with the native files, and the `artifact.json`, `versions.json` row, and `index.json` entry the indexer writes for it. CI runs the validator: path grammar, schemas, digests, kind manifest, and, against the branch the pull request targets, that no released version directory changed and that every released row is still listed with its digest.

A status change (deprecate, yank, archive) is a pull request that edits the version's existing row in `versions.json`: its `status`, `yanked`, and `reason`, and its `catalog_digest` when the row has one (section 4.3). This is the only hand edit the documents take. The indexer then runs again, so `latest` and `index.json` follow the new status. A row is never removed and its digest never changes (rule 7).

The documents an indexer produces are what any reader expects, so a reader cannot tell a repository root from any other.

Publishing to an HTTPS root needs a server and is [future work](registry/README.md).

## 10. What a file root does not do

No atomic publish across several artifacts, no server-side search or inbound relationship queries, no access control finer than the root, and listing performance that degrades past a few thousand artifacts. Each is a server feature, listed in [registry/](registry/README.md).

## 11. Client safety

A registry is untrusted input to the client that reads it. These rules bound what a client fetches, sends, and writes.

- **Schemes.** A client reads a root, a `blob_url`, a `manifest_url`, and a `files[].urls` entry over `https`, or from the local file system. It MUST NOT use plain `http` except to a loopback host (`localhost`, `127.0.0.0/8`, `::1`), and MUST refuse any other scheme.
- **Relative references.** A relative `files[].urls` entry resolves against the version directory and MUST stay inside it. A relative `blob_url` or `manifest_url` resolves against the root and MUST stay inside it. A client refuses a reference with a `..` segment, and on a file system one that reaches outside through a symbolic link.
- **Redirects.** A client follows a redirect only to the same origin or to an `https` URL, never from `https` to `http`, and follows a bounded number of them.
- **Credentials.** A client MUST send a stored credential only to the origin, meaning scheme, host and port, it was issued for, whatever location a project's files name. A token the person supplies through the environment for a registry name MUST go only to the registry of that name the client's effective configuration declares. A client MUST NOT send either after a redirect to another origin, or to a blob or file URL on another host.
- **Private addresses.** A client SHOULD NOT follow a redirect, an absolute `blob_url`, or an absolute `files[].urls` entry from a public host to a loopback, private, or link-local address.
- **Sizes and time.** A client MUST stop reading a file once it has received more bytes than the descriptor's `size`, and MUST verify the size and the digest before it uses the file. It SHOULD cap the size of each JSON document it parses, and give up on a request that takes too long rather than wait indefinitely.
- **Paths.** A client writes a file only at a path section 2.3 allows, inside the folder it installs into, and MUST NOT follow a symbolic link it finds there.
- **Cycles.** `depends_on` edges can form a cycle. A client resolves each ref once, so a cycle ends where it began.

aireg reads directory and git roots, not HTTPS roots. It applies the path, reference, and cycle rules to both and verifies every file's size and digest before using it. It refuses plain `http://` except to a loopback host, sends a stored credential only to the origin it was issued for and a token from the environment only to the registry of that name, and bounds each git operation with a timeout.
