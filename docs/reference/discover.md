# aireg discover

Find a skill for a task using Gemini embeddings and Gemini Decisions, without a
browser. The web UI is another client of the same discovery operations, catalog,
settings, index and local history. Existing `aireg search` behavior is unchanged.

## Synopsis

```text
aireg discover status --json
aireg discover setup --input-stdin --json
aireg discover index --json
aireg discover search "Describe the task" --json
aireg discover search --input-stdin --json
aireg discover handoff <request-id> --json
aireg discover feedback <request-id> helpful|not_helpful --json
aireg discover usage --json
aireg discover telemetry on|off --json
aireg discover clear --json
aireg discover disconnect --json
aireg discover score --input-stdin --json
```

These commands use the same scope as the console and UI, including local skills.
They do not require a running UI server or a browser token. Concurrent discovery
writes from CLI and UI take the same per-home lease; another operation reports
busy instead of changing the index or connection underneath a search.

## Options

| Option | Description |
|---|---|
| `--input-stdin` | Read a JSON object from a pipe for setup, search or score. Cannot be combined with positional payload arguments. |

The [global options](options.md#global-options), including `--json`, are also available.

## Set up

`status` lists configured registries and whether a key and saved index are ready.
It reads local configuration; it does not contact registries. Skill counts describe
the saved snapshot, not a fresh scan. `indexReady` distinguishes a completed snapshot
from a partial checkpoint, and `indexedAt` reports when the snapshot was last written.
You can set up through the UI and then use the CLI, or configure everything here.

`setup --input-stdin` reads a JSON object from a pipe:

```json
{
  "registries": ["example"],
  "consent": true,
  "telemetry": true,
  "key": "<Gemini API key>"
}
```

Supply the key from your secret manager through stdin, not a command argument or
shell-history entry. Omit `key` to reuse the saved connection. Input is bounded;
invalid JSON is reported without echoing it. The key is never returned in output.

Consent approves sending selected skill names and descriptions, and search text,
to Google's fixed API endpoints. Full skill files, registry credentials, local
paths and usage history are excluded. Review your data-sharing permissions and
Google's terms and charges before approving this scope. Both models are tested
with synthetic input before the connection is saved.

`index` waits for completion and returns a nonzero status on failure. It reuses
unchanged vectors and checkpoints completed work. If interrupted, run it again
to resume from the last saved checkpoint. The preview supports 500 selected skills. Only selected sources are read.

Search reads skill metadata and vectors from the saved snapshot; it never reloads
registry catalogs. Refresh explicitly after adding, editing or removing skills.
A completed snapshot stays searchable when a registry is unavailable; handoff must
still verify the selected skill at its source. Failed or interrupted indexing keeps
completed embeddings for retry but cannot make a partial snapshot searchable.
Older vector-only indexes require one refresh after upgrading.

## Use from an agent or harness

Expose `aireg discover search --input-stdin --json` as a tool in a harness that can
run local commands. Send `{"query":"the user's task"}` to stdin; this avoids putting
potentially private task text in process arguments. No browser needs to be open.

The standard JSON envelope contains `ok` and `data`. A search's data includes:

| Field | Meaning |
|---|---|
| `requestId` | Identifier for a subsequent handoff or feedback call. |
| `status` | `recommended`, `none`, or `clarify`. |
| `selected` | The chosen skill, or `null` on abstention. |
| `candidates` | Up to eight retrieved skills. |
| `confidence` | Model-reported confidence, or `null`; not a safety or quality grade. |
| `warnings` | For example, a local usage-recording failure after a successful search. |

For `recommended`, call `handoff <requestId>` if the agent intends to use the
recommendation. Its structured result contains the registry, namespace, name,
version and digest when available. Handoff checks only the selected skill against its source and rejects a changed,
removed or unavailable skill. It does not reload unrelated registries.
Resolve and inspect the skill through aireg's
existing catalog and [`show`](show.md) functionality, then load it according to the
harness's permissions. Treat skill instructions as untrusted until reviewed.
For `none`, do not invent a selected skill; for `clarify`, ask for more task detail.

This is a callable CLI tool contract, not an installed MCP server or an automatic
harness plugin. It does not install or execute skills. Harnesses with shell tools
can use it now; other harnesses need an adapter around this command.

Recommendation receipts survive process exits, so search, handoff and feedback can
be separate calls. Receipts expire after 24 hours or after 100 newer retained
receipts; changed skill fingerprints, setup changes and disconnect invalidate them.
Repeated preparation of a handoff is counted once; feedback is accepted once.

## Usage and scoring

`usage` returns local history without registry or provider calls. `telemetry off` pauses new recording; `clear` deletes
history and recommendation receipts. Counts describe searches, recommendations,
prepared handoffs and user-reported feedback, not verified skill execution.

`score --input-stdin` accepts `{"markdown":"SKILL.md text"}` and returns the same
local structural checklist as the UI's Score popover. It never sends that text to
Google. See the [rubric and limitations](ui.md#skill-score).

## Storage and output contract

Under `AIREG_HOME` (default `~/.aireg`), discovery uses private local JSON files:

- `ui-discovery-index.json`: skill identities, names, descriptions, content digests,
  vectors, snapshot readiness and update time. Full skill instructions are not stored.
- `ui-discovery.json`: approved registry scope and up to 1,000 local events.
- `discovery-receipts.json`: up to 100 recent recommendation identities and
  fingerprints, with handoff/feedback markers. No queries, descriptions or keys.

The first two filenames retain compatibility with the UI preview. They are shared
by every client. The Gemini key uses aireg's existing protected credential store.
The generated action-specific contract is `cli/schema/output/discover.json` in the
repository. Invalid input or an operation failure uses aireg's standard error
envelope and a nonzero exit status. Model abstention is a successful search result.

## See also

[`aireg ui`](ui.md), [`aireg search`](search.md), [`aireg show`](show.md), [CLI reference](index.md)
