# aireg ui

Browse your registries and what is installed, in your browser.

## Opening and reconnecting

Run `aireg ui` and use the browser tab it opens. Repeated launches reopen the running
UI for the same aireg home. A new server prefers port 3456 and falls back to a free
port if it is occupied. An explicit `--port` never silently falls back. The launch address authenticates that
tab; the page removes the credential from the address bar and keeps it in session storage.
Other tabs at the same address in that browser can reconnect through an open authenticated
tab. The server still requires authentication on every API request.

If the browser has no session, or the server restarted, the page shows a connection screen
instead of an empty registry. Run `aireg ui` again and use its new tab. A different browser
needs the complete launch address. Keep that address private.

If opening the browser fails, the CLI reports it. If permissions prevent reading run
history, installed artifacts still load with a warning; unavailable history is not presented
as evidence that the machine has no skills.

## Synopsis

```text
aireg ui [--port <port>] [--no-open]
aireg ui --no-open --json
```

## Description

`aireg ui` serves a page from this machine that shows every registry you have declared, what each one publishes, and what is installed here. It reads its state with the same code as [`aireg registry show`](registry.md) and [`aireg console`](console.md), in the scope the console shows: the one your background sync keeps current, or your user scope when there is none.

Each artifact a registry lists is marked with how it is installed: `ok`, `edited`, `missing` and the console's other states, or `available` when it is not installed yet. Work written on this machine shows under **this machine**, in the console's state. When a registry lists an artifact with the same name as such a folder, the page says so; it does not assume the folder is where that artifact came from. A skill a plugin carries is listed under the plugin, installs with it and leaves with it. The inspector shows the artifact's file, whether installed or as its registry serves it, its digests, and each target's link.

From the page you can:

- **Add** from a registry, a git repository or a folder. A dry run shows what would change first. A plugin that carries hooks, servers or programs that run as you is named with what it carries. The dry run lists plugins needing trust; select only those you have reviewed.
- **Sync** the scope shown, as `aireg sync --pull on --publish off --delete off` would.
- **Remove** an installed artifact using [`aireg remove`](remove.md). Unmanaged local folders cannot be removed from the UI. Archive and restore are not offered because the CLI does not provide them.
- **Check the machine**, as [`aireg doctor`](doctor.md) would.

These catalog and machine actions run as a child of the same `aireg`, so it takes the same lease the CLI does. The process that starts the server keeps serving until you press Ctrl+C. Later launches reopen it and exit.

A registry that is slow to answer does not hold up the page. It shows as being read, and the page reads again every few seconds until it answers. A registry that fails is marked unavailable in the sidebar; its details are available on hover. General read failures, including unavailable history, are also listed in **Check this machine**.

### Security

- The server listens on `127.0.0.1` only, on port 3456 by default, with a free-port fallback.
- Launcher reuse authenticates both ends of its local socket with a per-home key before returning the browser session.
- The address it prints and opens carries a token for this session after `#`, which a browser never sends to a server. Treat the address as a password while the command runs.
- Every API request needs the token. A request under any host name but the server's own is refused, which stops a page elsewhere that rebinds its name to `127.0.0.1`. An action also needs the server's own origin and a JSON body, which a page elsewhere cannot send.
- The page names artifacts by key, and the server finds them in aireg's own state; the only path it takes from the page is the address to add from, which follows `--`. Every name it passes on rides as `--flag=value`, and a value that starts with `-` is refused.
- Plugin trust is opt-in: enter the plugin names you reviewed. The UI passes those names through the existing `--trust` flag; aireg owns trust and installation semantics. Dry runs show the CLI's existing text output without extending its JSON contract.
- The UI never moves local folders into an archive or restores them with custom filesystem operations.

## Options

| Option | Description |
|---|---|
| `--port <port>` | Listen on this port, from 1024 to 65535, instead of the default. |
| `--no-open` | Print the address without opening a browser. |

`ui` also takes the [global options](options.md#global-options), such as `--json`. It doesn't take the [command options](options.md#command-options), such as `-g`.

## JSON output

`aireg ui --json` prints one line before it serves: `data.url` is the page's address, token included, and `data.port` is the port.

## Exit status

- `0`: the server stopped on Ctrl+C or `SIGTERM`.
- `1`: the port passed with `--port` is already in use.
- `2`: an option `ui` doesn't take, a port out of range, or an argument was passed.

## Examples

Open it in your browser:

```bash
aireg ui
```

Serve it for a script, without a browser:

```bash
aireg ui --no-open --json
```

## See also

[`aireg registry`](registry.md), [`aireg console`](console.md), [`aireg status`](status.md), [CLI reference](index.md)

## Skill discovery preview

**Find skills** is a browser client of [`aireg discover`](discover.md). The same
setup, index, routing, handoff, scoring and history work without a browser. Existing
install, remove, sync, and trust behavior is unchanged. Discovery does not install
or execute a skill, and does not modify manifests, lockfiles, or target folders.

### Set up and search

1. Open **Find skills → Setup**, then get a key from Google AI Studio.
2. Select registries and approve sharing their skill names and descriptions, plus
   your search text, with Google. No registry is selected by default. Only approve
   sources you are permitted to share; Google's API terms and charges apply.
3. Select **Test and save connection**. A synthetic request tests each model before
   the key is saved in aireg's existing private credential store.
4. Select **Build / refresh index**. Progress appears while up to 500 selected
   skills are embedded. Stop finishes the current request, with a 25-second deadline.
   Completed embeddings are retained for retry and reused after a restart.
5. In **Search**, describe your task. Review the recommendation and retrieved
   candidates, then select **Prepare handoff** to copy a JSON description into your agent.

The implementation uses `gemini-embedding-2` for embeddings and
`gemini-decision-1` for the decision. Keyword and vector rankings are combined
with reciprocal rank fusion; up to eight candidates reach the decision model.
The decision can select one candidate, abstain, or request clarification. The
model's confidence is displayed separately from the skill's checklist score.
Neither number establishes safety or measured task performance.

The handoff includes the selected skill's registry, namespace, name, version and
digest when available. It is an experimental UI handoff, not a harness protocol:
the receiving agent must resolve and inspect the skill before using it. A changed
catalog invalidates the recommendation. There is no automatic execution or
verified execution reporting in this preview.

### Data and local history

The server sends only selected skill names and descriptions and the submitted
query to fixed Google API endpoints. Full skill files, local paths, registry
credentials, and telemetry are not sent. Descriptions and queries may themselves
contain sensitive information; review the scope before consenting. Provider errors
are summarized without reflecting response bodies.

Under the aireg home, `ui-discovery-index.json` stores private fingerprints and
vectors; `ui-discovery.json` stores selected registries and at most 1,000 local
events. The cache is tied to the embedding model and each skill's metadata and
version. Refreshing embeds only changed entries. Corrupt or incompatible cache
contents require rebuilding. Disconnect removes the saved Gemini key, approved
scope and cached vectors; history remains until cleared.

**Usage** distinguishes successful searches, recommendations, prepared handoffs
and self-reported feedback. Repeated preparation of one handoff does not inflate
its count, and one recommendation accepts feedback once. These events contain
local skill identifiers, versions, digests, timings and outcomes, never search
text, source content or API keys. Counts cover retained events, not lifetime usage.
Pause/resume and clearing history work locally without calling Google. Clearing
also expires recommendation receipts, which otherwise survive process exits for up
to 24 hours (at most 100 retained). A recording
failure is shown in Usage and does not discard an otherwise successful search.

### Skill score

The inspector's **Score** button opens an on-demand checklist for the file being
viewed. Scoring is entirely local; it never sends the file to a model. The
`authoring-signals-v1` rubric totals ten weighted checks: metadata (5), name (5),
description (15), activation guidance (10), procedure (15), output (10), examples
(10), verification (15), recovery (5), and entry-point size (10).

These are English text and structure heuristics, not an objective quality grade.
Supporting files and actual execution are not evaluated. The popover exposes the
evidence, suggested improvements, and questions that still need human review.
Scores do not filter search results or authorize a handoff.

### Provider references

The transport and text prefixes follow Google's
[Gemini Decisions example](https://codelabs.developers.google.com/codelabs/discriminative-models)
and [Gemini embeddings documentation](https://ai.google.dev/gemini-api/docs/embeddings).
Provider availability, quotas, and real-task recommendation quality must be checked
with your AI Studio project; automated repository tests use synthetic providers.
