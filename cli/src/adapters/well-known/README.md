# well-known adapter

Reads a site's Agent Skills discovery index, `/.well-known/agent-skills/index.json` in its 0.2.0 format, addressed by the site's `https://` URL (or `http://localhost` on this machine). It looks beside the address first, then at the site's root. Every skill is checked against the sha256 digest the index gives before anything installs, and an archive is unpacked in memory within its limits, refusing links and paths that leave it. It sends no credentials, has no versions and takes no publishes. Built on the public contract alone, as a third-party adapter would be.

| File | What it does |
|---|---|
| `index.ts` | The `defineAdapter` entry: a site claim on web addresses that are not a code host's or a repository's |
| `connect.ts` | Finds and checks the index, fetches each skill, verifies its digest and builds its envelope |
| `archive.ts` | Unpacks a `.tar.gz` or `.zip` skill archive, within its file and byte limits |
| `errors.ts` | The adapter's id and its failures |
| `api.ts` | The only module the rest of the CLI imports |
| `compliance.test.ts` | `assertAdapterCompliance` against a site served on this machine |
