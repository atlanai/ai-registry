import { join } from "node:path";
import { isRecord } from "#adapter/fields.ts";
import { readRegular } from "#adapter/files.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { PRIVATE_FILE } from "#core/fs/mode.ts";
import { withLease } from "#core/lease/lease.ts";
import { UI_DISCOVERY_INDEX_FILE } from "#core/product.ts";
import { ensureHome } from "#core/store/paths.ts";
import { DiscoveryError, EMBEDDING_MODEL, validVector } from "./gemini.ts";
import type { Indexed } from "./retrieval.ts";

/** A rebuildable, private cache. It contains fingerprints and vectors, never source text. */
export class DiscoveryIndex {
  private readonly env: NodeJS.ProcessEnv;
  constructor(env: NodeJS.ProcessEnv) {
    this.env = env;
  }

  async read(): Promise<Map<string, Indexed>> {
    const file = await readRegular(ensureHome(this.env), UI_DISCOVERY_INDEX_FILE);
    if (file.kind === "missing") return new Map();
    if (file.kind !== "file") throw new DiscoveryError("The search index cannot be read safely.");
    try {
      const value: unknown = JSON.parse(file.bytes.toString());
      if (
        !isRecord(value) ||
        value.schema !== 1 ||
        value.model !== EMBEDDING_MODEL ||
        !Array.isArray(value.entries) ||
        value.entries.length > 500
      )
        return new Map();
      const entries = new Map<string, Indexed>();
      for (const entry of value.entries) {
        if (
          !isRecord(entry) ||
          typeof entry.fingerprint !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
          !validVector(entry.vector)
        )
          return new Map();
        entries.set(entry.fingerprint, { fingerprint: entry.fingerprint, vector: entry.vector });
      }
      return entries;
    } catch {
      return new Map();
    }
  }

  async save(entries: Iterable<Indexed>): Promise<void> {
    const path = join(ensureHome(this.env), UI_DISCOVERY_INDEX_FILE);
    await withLease({ scope: "user", lock: path }, { wait: true, env: this.env }, async () => {
      const existing = await readRegular(ensureHome(this.env), UI_DISCOVERY_INDEX_FILE);
      if (existing.kind === "refused")
        throw new DiscoveryError("The search index cannot be written safely.");
      await writeAtomic(
        path,
        JSON.stringify({ schema: 1, model: EMBEDDING_MODEL, entries: [...entries] }),
        PRIVATE_FILE,
      );
    });
  }
}
