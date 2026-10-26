# git adapter

Reads a registry kept in a git repository: `https://`, `ssh://`, `file://` and `git@host:path` addresses (plain `http://` only on loopback), and any address no other adapter claims. It pins the commit it read (`pinsSource`), does not publish, and signs in with git's own credentials (`credentialsHint`). Built on the public contract alone, as a third-party adapter would be.

| File | What it does |
|---|---|
| `index.ts` | The `defineAdapter` entry: dispatch, capabilities, readiness checks |
| `connect.ts` | Resolves a ref, checks out that commit, and hands the checkout to the contract's folder registry |
| `errors.ts` | The adapter's id, its credentials hint, and the translation of file spec failures |
| `exec.ts`, `env.ts` | The git process runner, its failure classification and its environment |
| `resolve.ts`, `clone.ts`, `transport.ts`, `snapshot.ts`, `url.ts` | Ref resolution, the transport ladder every network operation walks, the cached checkout per commit, and address parsing |
| `api.ts` | The only module the rest of the CLI imports |
| `compliance.test.ts` | `assertAdapterCompliance` against a local bare repository |
