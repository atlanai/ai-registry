import { join } from "node:path";
import { isRecord } from "#adapter/fields.ts";
import { readRegular } from "#adapter/files.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { PRIVATE_FILE } from "#core/fs/mode.ts";
import { withLease } from "#core/lease/lease.ts";
import { DISCOVERY_INDEX_FILE } from "#core/product.ts";
import { ensureHome } from "#core/store/paths.ts";
import { DiscoveryError, EMBEDDING_MODEL, validVector } from "./gemini.ts";
import { fingerprint, type Indexed, type Skill } from "./retrieval.ts";

export interface IndexedSkill extends Indexed {
  skill: Skill;
}
export interface Snapshot {
  entries: Map<string, IndexedSkill>;
  complete: boolean;
  updatedAt: string | null;
}
const empty = (): Snapshot => ({ entries: new Map(), complete: false, updatedAt: null });

/** Private search snapshot: metadata and vectors, never full instructions or credentials. */
export class DiscoveryIndex {
  private readonly env: NodeJS.ProcessEnv;
  constructor(env: NodeJS.ProcessEnv) {
    this.env = env;
  }
  async read(): Promise<Snapshot> {
    const file = await readRegular(ensureHome(this.env), DISCOVERY_INDEX_FILE);
    if (file.kind === "missing") return empty();
    if (file.kind !== "file") throw new DiscoveryError("The search index cannot be read safely.");
    try {
      const value: unknown = JSON.parse(file.bytes.toString());
      if (
        !isRecord(value) ||
        value.schema !== 2 ||
        value.model !== EMBEDDING_MODEL ||
        typeof value.complete !== "boolean" ||
        typeof value.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(value.updatedAt)) ||
        !Array.isArray(value.entries) ||
        value.entries.length > 500
      )
        return empty();
      const entries = new Map<string, IndexedSkill>();
      const keys = new Set<string>();
      for (const entry of value.entries) {
        if (
          !isRecord(entry) ||
          !validSkill(entry.skill) ||
          !validVector(entry.vector) ||
          entry.fingerprint !== fingerprint(entry.skill) ||
          keys.has(entry.skill.key)
        )
          return empty();
        keys.add(entry.skill.key);
        entries.set(entry.fingerprint, {
          fingerprint: entry.fingerprint,
          vector: entry.vector,
          skill: entry.skill,
        });
      }
      return { entries, complete: value.complete, updatedAt: value.updatedAt };
    } catch {
      return empty();
    }
  }
  async save(entries: Iterable<IndexedSkill>, complete = false): Promise<void> {
    const path = join(ensureHome(this.env), DISCOVERY_INDEX_FILE);
    await withLease({ scope: "user", lock: path }, { wait: true, env: this.env }, async () => {
      const existing = await readRegular(ensureHome(this.env), DISCOVERY_INDEX_FILE);
      if (existing.kind === "refused")
        throw new DiscoveryError("The search index cannot be written safely.");
      await writeAtomic(
        path,
        JSON.stringify({
          schema: 2,
          model: EMBEDDING_MODEL,
          complete,
          updatedAt: new Date().toISOString(),
          entries: [...entries],
        }),
        PRIVATE_FILE,
      );
    });
  }
}
function validSkill(value: unknown): value is Skill {
  return (
    isRecord(value) &&
    ["key", "name", "registry", "namespace", "description", "version", "digest"].every(
      (key) => typeof value[key] === "string" && value[key].length <= 16_384,
    ) &&
    typeof value.key === "string" &&
    value.key.length > 0
  );
}
