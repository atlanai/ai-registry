import { join } from "node:path";
import { isRecord } from "#adapter/fields.ts";
import { readRegular } from "#adapter/files.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { PRIVATE_FILE } from "#core/fs/mode.ts";
import { DISCOVERY_RECEIPTS_FILE } from "#core/product.ts";
import { ensureHome } from "#core/store/paths.ts";
import { DiscoveryError } from "./gemini.ts";
import type { Skill } from "./retrieval.ts";

export interface Receipt {
  requestId: string;
  at: number;
  skill: Omit<Skill, "description"> | null;
  fingerprint: string;
  handedOff: boolean;
  feedback: boolean;
}
/** Called only inside the shared discovery operation lease. No queries or descriptions. */
export class Receipts {
  private readonly env: NodeJS.ProcessEnv;
  constructor(env: NodeJS.ProcessEnv) {
    this.env = env;
  }
  async read(): Promise<Receipt[]> {
    const file = await readRegular(ensureHome(this.env), DISCOVERY_RECEIPTS_FILE);
    if (file.kind === "missing") return [];
    if (file.kind !== "file")
      throw new DiscoveryError("Recommendation receipts cannot be read safely.");
    try {
      const value: unknown = JSON.parse(file.bytes.toString());
      if (!Array.isArray(value) || value.length > 100 || !value.every(valid)) throw new Error();
      return value.filter((r) => r.at > Date.now() - 24 * 60 * 60_000);
    } catch {
      throw new DiscoveryError(
        "Recommendation receipts are invalid. Clear local history to reset them.",
      );
    }
  }
  async save(receipts: Receipt[]): Promise<void> {
    const home = ensureHome(this.env);
    const file = await readRegular(home, DISCOVERY_RECEIPTS_FILE);
    if (file.kind === "refused")
      throw new DiscoveryError("Recommendation receipts cannot be written safely.");
    await writeAtomic(
      join(home, DISCOVERY_RECEIPTS_FILE),
      JSON.stringify(receipts.slice(-100)),
      PRIVATE_FILE,
    );
  }
}
function valid(value: unknown): value is Receipt {
  const skill = isRecord(value) ? value.skill : undefined;
  return (
    isRecord(value) &&
    typeof value.requestId === "string" &&
    typeof value.at === "number" &&
    Number.isFinite(value.at) &&
    typeof value.fingerprint === "string" &&
    typeof value.handedOff === "boolean" &&
    typeof value.feedback === "boolean" &&
    (skill === null ||
      (isRecord(skill) &&
        ["key", "name", "registry", "namespace", "version", "digest"].every(
          (k) => typeof skill[k] === "string",
        )))
  );
}
