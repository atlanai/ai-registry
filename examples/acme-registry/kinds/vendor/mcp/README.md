# MCP Registry schemas

The JSON Schemas the [`mcp_server`](../../mcp_server.json) kind validates a `server.json` against,
copied byte for byte from what the [MCP Registry](https://github.com/modelcontextprotocol/registry)
publishes at each schema's `$id`. Apache-2.0 or MIT, as the registry's `LICENSE` describes for
its contributions. Nothing here is edited, so each file keeps the `$id` its project gave it and is
reached by its path here.

| Schema version | File | Source | sha256 |
|---|---|---|---|
| 2025-12-11 | [2025-12-11/server.schema.json](2025-12-11/server.schema.json) | `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`, last modified 12 Dec 2025 | `3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0` |

The file published at the `$id` is the copy that counts. The MCP Registry's own validator keeps a
copy of 2025-12-11 that has since gained `cargo` and `https://crates.io` as examples and a
255-character limit on a package's `version`. Only that limit validates differently, and a
`server.json` that breaks it fails at the MCP Registry while it passes here.

These schemas declare JSON Schema draft-07, while the kind manifests declare 2020-12. A 2020-12
validator applies a referenced resource by that resource's own `$schema`. A validator that cannot
mix dialects in one instance, such as Ajv, applies 2020-12 semantics instead, which give the same
result only for keywords whose meaning did not change between the two drafts.
`tools/check_schemas.py` refuses a draft-07 copy that uses any of the others: an array-valued
`items`, `additionalItems`, `dependencies`, or `$ref` beside any keyword but an annotation,
`$id` included, since a 2020-12 `$id` moves the base a `$ref` resolves against.

To add a schema version, copy the file served at its `$id` into a folder named after the version,
add a row here, and add the URL to `$schema.enum` and an `if`/`then` to `allOf` under
`$defs.document` in `mcp_server.json`.
