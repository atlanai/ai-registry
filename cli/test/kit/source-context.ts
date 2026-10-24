import { mkdirSync } from "node:fs";
import type { SourceContext } from "#adapter/index.ts";

/** A context as the host gives an adapter, with no other process to wait for. `cache` is the test's own. */
export function sourceContext(source: SourceContext["source"], cache: string): SourceContext {
  return {
    source,
    credential: undefined,
    signal: new AbortController().signal,
    // The host's default: a Windows runner can take over a second to clone a local repository.
    limits: { timeoutMs: 30_000, retries: 0 },
    onBytes: () => {},
    cacheDir: () => {
      mkdirSync(cache, { recursive: true });
      return cache;
    },
    exclusive: (_key, run) => run(),
  };
}
