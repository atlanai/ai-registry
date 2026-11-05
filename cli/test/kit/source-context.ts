import { mkdirSync } from "node:fs";
import type { SourceContext } from "#adapter/index.ts";

/** Without its own `cache`, an adapter that asks for one fails the test. */
export function sourceContext(source: SourceContext["source"], cache?: string): SourceContext {
  return {
    source,
    credential: undefined,
    signal: new AbortController().signal,
    limits: { timeoutMs: 30_000, retries: 0 },
    onBytes: () => {},
    cacheDir: () => {
      if (cache === undefined) throw new Error(`${source.registry} asked for a cache.`);
      mkdirSync(cache, { recursive: true });
      return cache;
    },
    exclusive: (_key, run) => run(),
  };
}
