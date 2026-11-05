# core/filespec

Registry authoring: what `aireg registry init`, `index`, `validate`, `skill new` and `publish` write into a registry folder. Reading a registry, its name rules, document names and the merges a publish writes are the public contract's, in `src/adapter/filespec/`, so a third-party adapter for a file spec store uses the same engine.

| File | What it does |
|---|---|
| `init.ts` | Finds the registry around a folder, and writes an empty one |
| `indexer.ts` | Gives every unlisted version folder its `artifact.json`, a `versions.json` row and an `index.json` entry |
| `validate/` | Everything a pull request could get wrong: documents read, the `--base` diff, version folders and catalog rows; git, for `--base`, is the caller's to supply |
| `kind-manifests.ts` | Kind manifests: the files a kind needs and the `spec` its front matter fills |
| `offer.ts` | One artifact on disk as an adapter takes it for a publish |
| `schema.ts` | Checks a document against a kind's JSON Schema |
