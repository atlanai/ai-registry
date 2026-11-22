import { type FSWatcher, watch } from "node:fs";
import type { ServerResponse } from "node:http";
import { messageOf } from "#adapter/errors.ts";
import type { PageReader } from "./page-state.ts";
import type { UiEvent, UiState } from "./protocol.ts";
import { viewOf } from "./view.ts";

const HEARTBEAT_MS = 15_000;
const DEBOUNCE_MS = 300;
const LOADING_MS = 3_000;
/** A few tabs; more is a page reconnecting in a loop. */
const MOST_CLIENTS = 16;

/** Pushes `UiEvent`s to every open `GET /events`, and says `state.changed` when the disk changes. */
export class Events {
  readonly #clients = new Set<ServerResponse>();
  readonly #watchers: FSWatcher[] = [];
  readonly #reader: PageReader;
  readonly #heartbeat: NodeJS.Timeout;
  #debounce: NodeJS.Timeout | undefined;
  #again: NodeJS.Timeout | undefined;
  /** What the page last saw, less the time; a change to nothing else is not a change. */
  #seen = "";
  #always = false;

  constructor(reader: PageReader) {
    this.#reader = reader;
    this.#heartbeat = setInterval(() => {
      for (const client of this.#clients) client.write(": ping\n\n");
    }, HEARTBEAT_MS);
    this.#heartbeat.unref();
  }

  /** False when too many are open already. */
  attach(response: ServerResponse, headers: Record<string, string>): boolean {
    if (this.#clients.size >= MOST_CLIENTS) return false;
    response.writeHead(200, {
      ...headers,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    response.write(": connected\n\n");
    this.#clients.add(response);
    response.once("close", () => this.#clients.delete(response));
    this.changed();
    return true;
  }

  emit(event: UiEvent): void {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.#clients) client.write(frame);
  }

  /** Folders whose files the page shows; one that does not exist yet is skipped. */
  watch(folders: readonly string[]): void {
    for (const folder of new Set(folders)) {
      try {
        const watcher = watch(folder, { persistent: false }, (_event, name) => {
          // Reading the run store touches its journal; that alone would read again forever.
          if (name === null || !/-(shm|wal|journal)$/.test(name)) this.changed();
        });
        watcher.on("error", () => watcher.close());
        this.#watchers.push(watcher);
      } catch {
        // Missing or unreadable: the state read after an action still covers it.
      }
    }
  }

  /** Reads again soon and says `state` when what the page shows moved, or always after an action. */
  changed(always = false): void {
    this.#always ||= always;
    clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => void this.#refresh(), DEBOUNCE_MS);
    this.#debounce.unref();
  }

  #later(): void {
    clearTimeout(this.#again);
    this.#again = setTimeout(() => this.changed(), LOADING_MS);
    this.#again.unref();
  }

  close(): void {
    clearInterval(this.#heartbeat);
    clearTimeout(this.#again);
    clearTimeout(this.#debounce);
    for (const watcher of this.#watchers) watcher.close();
    for (const client of this.#clients) client.end();
    this.#clients.clear();
  }

  async #refresh(): Promise<void> {
    try {
      const view = viewOf(await this.#reader.read(true));
      // A registry still answering is not on disk to watch, so read again until it has.
      if (view.registries.some((registry) => registry.loading)) this.#later();
      const seen = fingerprint(view);
      const always = this.#always;
      this.#always = false;
      if (seen === this.#seen && !always) return;
      this.#seen = seen;
      this.emit({ type: "state.changed", readAtMs: view.readAtMs });
    } catch (error) {
      console.error(`aireg ui: ${messageOf(error)}`);
    }
  }
}

function fingerprint(view: UiState): string {
  const { readAtMs: _readAtMs, ...rest } = view;
  return JSON.stringify(rest);
}
