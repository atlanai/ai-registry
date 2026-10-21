# local adapter

Reads a registry folder on this machine, addressed by a path (`./kit`, `~/kit`, `/src/kit`), in place: nothing is copied before it installs. It publishes by writing the file spec's layout into that folder (`publish`, `fileSpec`), with each version's relationships in its `artifact.json` (`relationships`) and every file of a folder agent beside its `AGENT.md` (`agentFolders`), one writer at a time through the host's `exclusive`. Built on the public contract alone, as a third-party adapter would be.

| File | What it does |
|---|---|
| `index.ts` | The `defineAdapter` entry: dispatch, capabilities and the kinds it publishes |
| `connect.ts` | The folder checks, then the contract's folder registry for resolve and fetch, and publish |
| `publish.ts` | Writes offered versions, their envelopes, `versions.json` and `index.json` into the folder |
| `errors.ts` | The adapter's id and the translation of file spec failures |
| `api.ts` | The only module the rest of the CLI imports |
| `compliance.test.ts` | `assertAdapterCompliance` against a registry folder |
