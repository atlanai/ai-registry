import { join } from "node:path";
import { isRecord } from "#adapter/fields.ts";
import { readRegular } from "#adapter/files.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { PRIVATE_FILE } from "#core/fs/mode.ts";
import { withLease } from "#core/lease/lease.ts";
import { UI_DISCOVERY_FILE } from "#core/product.ts";
import { ensureHome } from "#core/store/paths.ts";
import { DiscoveryError } from "./gemini.ts";

export interface UsageEvent {
  id: string;
  at: string;
  type: "search" | "recommendation" | "handoff" | "feedback" | "error";
  requestId: string;
  skillKey: string;
  skillVersion?: string;
  skillDigest?: string;
  durationMs: number;
  outcome: string;
}
export interface Saved {
  registries: string[];
  events: UsageEvent[];
  telemetry: boolean;
}
export class DiscoveryStore {
  private readonly env: NodeJS.ProcessEnv;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }
  private async edit(change: (saved: Saved) => void): Promise<Saved> {
    const home = ensureHome(this.env);
    const path = join(home, UI_DISCOVERY_FILE);
    return withLease({ scope: "user", lock: path }, { wait: true, env: this.env }, async () => {
      const saved = await this.read();
      change(saved);
      await writeAtomic(path, JSON.stringify(saved), PRIVATE_FILE);
      return saved;
    });
  }
  async read(): Promise<Saved> {
    const result = await readRegular(ensureHome(this.env), UI_DISCOVERY_FILE);
    if (result.kind === "missing") return { registries: [], events: [], telemetry: true };
    if (result.kind !== "file")
      throw new DiscoveryError("The discovery settings file cannot be read safely.");
    try {
      const value: unknown = JSON.parse(result.bytes.toString());
      if (
        !isRecord(value) ||
        !Array.isArray(value.registries) ||
        !value.registries.every((x) => typeof x === "string") ||
        !Array.isArray(value.events) ||
        !value.events.every(validEvent) ||
        typeof value.telemetry !== "boolean"
      )
        throw new Error();
      return {
        registries: value.registries,
        events: value.events.slice(-1000),
        telemetry: value.telemetry,
      };
    } catch {
      throw new DiscoveryError(
        "The discovery settings file is invalid. Restore it before continuing.",
      );
    }
  }
  settings(registries: string[], telemetry: boolean): Promise<Saved> {
    return this.edit((saved) => {
      saved.registries = registries;
      saved.telemetry = telemetry;
    });
  }
  event(event: UsageEvent): Promise<Saved> {
    return this.edit((saved) => {
      if (saved.telemetry) saved.events = [...saved.events, event].slice(-1000);
    });
  }
  clear(): Promise<Saved> {
    return this.edit((saved) => {
      saved.events = [];
    });
  }
}
function validEvent(value: unknown): value is UsageEvent {
  return (
    isRecord(value) &&
    ["id", "at", "type", "requestId", "skillKey", "outcome"].every(
      (k) => typeof value[k] === "string",
    ) &&
    ["search", "recommendation", "handoff", "feedback", "error"].includes(String(value.type)) &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs)
  );
}
