# The `aireg ui` page

The browser page that [`aireg ui`](../../docs/reference/ui.md) serves. It shows every registry the user has declared, what each one publishes, and what is installed on this machine.

## Layout

- `index.html`, `src/main.tsx`: the entry. A React app built with Vite and Tailwind; Radix primitives back the small components in `src/components/ui/`.
- `src/styles.css`: the design tokens, as Tailwind theme values. They are the original page's palette, type and shadows; the page is light only.
- `src/lib/rpc.ts`: the session exchange and the JSON-RPC client. Types come from the contract in `../src/cli/ui/protocol.ts`, imported type-only.
- `src/lib/events.ts`: one `EventSource` on `/events`. A `state.changed` event refetches state; `run.event` feeds the live logs. The names follow the daemon's JSON-RPC. Nothing polls.
- `mock/`: a Vite plugin that answers `/session`, `/rpc` and `/events` from fixtures, for `pnpm run ui:dev`. It never reaches the build.
- The server is TypeScript in `../src/cli/ui/`: the request guard, the in-process readers of registries and installed state, and the methods this page calls.

## Toward the daemon

The page's protocol mirrors the daemon's JSON-RPC in `../src/daemon/rpc/methods.ts`: `state.snapshot` for state, a `state.changed` event when it moves, and one `run.event` notification per run event, shaped as the daemon's `RunEvent`. The server in `../src/cli/ui/` is meant to become a bridge to the daemon, so keep new methods and events named and shaped as the daemon's would be.

## Working on it

The build in `dist/` ships inside the CLI as a generated module, so the npm package, the standalone binary and `pnpm dev` all carry it:

```bash
pnpm run ui:dev      # the page alone, against the mock server
pnpm run ui:build    # vite build into ui/dist
pnpm run ui          # build, then generate src/cli/ui/assets.ts, which is not committed
pnpm dev ui          # serve it from source
```

Dependencies the build bundles are dev dependencies; `scripts/notices/generate.ts` lists them in `UI_BUNDLED` so their licenses reach `THIRD_PARTY_NOTICES.txt`. Add a new one there too.

## Rules the page keeps

- Everything it shows comes from the server, which reads it from aireg. Nothing names a path, a registry or a number of its own.
- The launch token in the address is traded once for an HttpOnly cookie and removed from history. A 401 shows the session-ended screen.
- Markdown renders without raw HTML and passes `rehype-sanitize`. Links open only for HTTP(S) and `mailto`, and images never load.
- The CSP allows only the server's own files: no inline scripts, style tags or third-party resources, fonts included.
- Words follow the CLI: target, registry, edited, missing, run. Every action shows the exact `aireg` command it runs.
- Single-key shortcuts never act while focus is in a field or a dialog is open.
