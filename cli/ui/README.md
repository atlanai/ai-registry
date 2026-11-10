# The `aireg ui` page

The browser page that [`aireg ui`](../../docs/reference/ui.md) serves. It shows every registry the user has declared, what each one publishes, and what is installed on this machine.

## Layout

- `public/index.html` and `public/style.css`: the page and its styles. No inline styles or scripts: the server's content security policy allows only these files.
- `public/js/`: the page's ES modules. Dependencies run one way, `core` → `markdown` → `catalog` / `machine` → `dialogs` → `main`. A call that would loop back goes through `hooks` in `core.js`, which `main.js` fills in.
- The server is TypeScript in `../src/cli/ui/`: the request guard, the in-process readers of registries and installed state, and the routes this page calls.

## Working on it

The page ships inside the CLI as a generated module, so the npm package, the standalone binary and `pnpm dev` all carry it:

```bash
pnpm run ui          # regenerate src/cli/ui/assets.ts after changing anything here
pnpm run ui --check  # what `pnpm run verify` runs: fails when the module is stale
pnpm dev ui          # serve it from source
```

## Rules the page keeps

- Everything it shows comes from the server, which reads it from aireg. Nothing names a path, a registry or a number of its own.
- A value from the server is escaped before it reaches HTML, and rendered Markdown passes `sanitizeHtml` in `core.js`. Raw HTML in a file stays text, links open only for `https` and `mailto`, and images never load.
- Words follow the CLI: target, registry, edited, missing, run. Results say what happened and what to do next.
- Keys never act while focus is in a field or a dialog is open.
