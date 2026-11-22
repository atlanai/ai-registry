import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import type { UiEvent, UiRunEventBody, UiRunStarted, UiState } from "../../src/cli/ui/protocol.ts";
import { initialState, SAMPLE_FILE } from "./fixtures.ts";

type Handler = (params: Record<string, unknown>) => unknown;

const STEP_MS = 250;

/** Fixture state that changes as the page acts, and the event streams watching it. */
class MockStore {
  state: UiState = initialState();
  readonly clients = new Set<ServerResponse>();
  #runs = 0;
  #seq = 0;

  emit(event: UiEvent): void {
    for (const client of this.clients)
      client.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  changed(): void {
    this.state = { ...this.state, readAtMs: Date.now() };
    this.emit({ type: "state.changed", readAtMs: this.state.readAtMs });
  }

  launch(label: string, command: string, lines: string[], done: () => void): UiRunStarted {
    const runId = `run_${++this.#runs}`;
    const run = {
      id: runId,
      label,
      state: "running",
      startedAtMs: Date.now(),
      endedAtMs: undefined,
      error: undefined,
    };
    this.state = { ...this.state, runs: [run, ...this.state.runs] };
    this.changed();
    lines.forEach((line, at) => {
      setTimeout(
        () => this.#event(runId, { eventType: "run.output", data: { line } }),
        STEP_MS * (at + 1),
      );
    });
    setTimeout(() => this.#finish(runId, label, done), STEP_MS * (lines.length + 1));
    return { runId, command };
  }

  #finish(runId: string, label: string, done: () => void): void {
    done();
    const runs = this.state.runs.map((run) =>
      run.id === runId ? { ...run, state: "succeeded", endedAtMs: Date.now() } : run,
    );
    this.state = { ...this.state, runs };
    this.#event(runId, {
      eventType: "run.finished",
      data: { ok: true, exitCode: 0, summary: `${label} finished.` },
    });
    this.changed();
  }

  #event(runId: string, event: UiRunEventBody): void {
    this.emit({ type: "run.event", runId, seq: ++this.#seq, occurredAtMs: Date.now(), ...event });
  }

  mark(key: string, next: string): void {
    const artifacts = this.state.artifacts.map((artifact) =>
      artifact.key === key || artifact.name === key
        ? {
            ...artifact,
            state: next,
            installedVersion: next === "ok" ? artifact.version : "",
            removable: next === "ok",
          }
        : artifact,
    );
    this.state = { ...this.state, artifacts };
  }
}

function plan(params: Record<string, unknown>) {
  const source = String(params.source);
  if (source.includes("bad")) {
    throw Object.assign(new Error("That source could not be read."), {
      hint: "Check the address.",
    });
  }
  const names = Array.isArray(params.select) ? params.select.map(String) : ["review-helper-5"];
  return {
    planId: `plan_${Date.now()}`,
    source,
    changes: names.map((name) => ({ name, kind: "skill", action: "install", version: "1.0.0" })),
    trustNeeded: source.includes("plugin")
      ? [{ plugin: "example-plugin", carries: ["hooks", "an MCP server"] }]
      : [],
    output: `Would install ${names.join(", ")}.`,
    command: `aireg add ${source} --only ${names.join(",")}`,
  };
}

function handlers(store: MockStore): Record<string, Handler> {
  return {
    "state.snapshot": () => store.state,
    "artifact.file": (params) => ({
      key: String(params.key),
      text: SAMPLE_FILE,
      from: "installed",
    }),
    "install.plan": plan,
    "install.apply": () =>
      store.launch(
        "add",
        "aireg add example/public-registry",
        ["Resolving…", "Fetching…", "Linking into claude-code", "Done."],
        () => store.mark("review-helper-5", "ok"),
      ),
    "remove.start": (params) =>
      store.launch(
        "remove",
        `aireg remove ${String(params.key)}`,
        ["Unlinking…", "Deleting…"],
        () => store.mark(String(params.key), "available"),
      ),
    "sync.start": () =>
      store.launch(
        "sync",
        "aireg sync",
        ["Reading lockfile…", "3 artifacts current", "Done."],
        () => undefined,
      ),
    "doctor.run": () => ({
      ok: false,
      checks: [
        { name: "Lockfile", ok: true, detail: "" },
        { name: "Links", ok: false, detail: "2 links point at missing folders. Run `aireg sync`." },
      ],
      output: "doctor output",
    }),
    "run.cancel": () => ({ cancelled: false }),
  };
}

async function answer(
  request: IncomingMessage,
  response: ServerResponse,
  table: Record<string, Handler>,
) {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  const call = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    id: number;
    method: string;
    params?: Record<string, unknown>;
  };
  response.setHeader("content-type", "application/json");
  try {
    const handler = table[call.method];
    if (handler === undefined) throw new Error("There is no such method.");
    response.end(
      JSON.stringify({ jsonrpc: "2.0", id: call.id, result: handler(call.params ?? {}) }),
    );
  } catch (error) {
    const { message, hint } = error as Error & { hint?: string };
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: call.id,
        error: { code: -32000, message, data: { hint } },
      }),
    );
  }
}

/** Fixture `/session`, `/rpc` and `/events` for `vite` alone; never part of the build. */
export function mockServer(): Plugin {
  const store = new MockStore();
  const table = handlers(store);
  return {
    name: "aireg-mock-server",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "/").split("?")[0];
        if (path === "/session" && request.method === "POST") {
          response.writeHead(204, {
            "set-cookie": "aireg-mock=1; HttpOnly; SameSite=Strict; Path=/",
          });
          response.end();
        } else if (path === "/events") {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
          });
          response.write(": connected\n\n");
          store.clients.add(response);
          request.on("close", () => store.clients.delete(response));
        } else if (path === "/rpc" && request.method === "POST") {
          void answer(request, response, table);
        } else {
          next();
        }
      });
    },
  };
}
