import { type SkillScore, scoreSkill } from "#core/score/skill.ts";
import { DiscoveryError } from "./gemini.ts";
import type { DiscoveryStatus, Handoff, Message, Recommendation } from "./model.ts";
import type { Skill } from "./retrieval.ts";
import type { Discovery } from "./service.ts";

export interface DiscoveryCatalog {
  available(): Promise<string[]>;
  list(registries: string[]): Promise<Skill[]>;
  resolve(skill: Skill): Promise<Skill | undefined>;
}

/** Shared operation dispatch; transports supply inputs and a catalog, never business rules. */
export async function discover(
  service: Discovery,
  action: string,
  payload: Record<string, unknown>,
  catalog: DiscoveryCatalog,
  background = false,
): Promise<DiscoveryStatus | Handoff | Message | Recommendation | SkillScore> {
  switch (action) {
    case "stop":
      return service.stop();
    case "clear":
      return service.clear();
    case "disconnect":
      return service.disconnect();
    case "telemetry":
      return service.telemetry(payload);
    case "feedback":
      return service.feedback(payload);
    case "score":
      if (typeof payload.markdown !== "string")
        throw new DiscoveryError("Supply markdown text to score.");
      return scoreSkill(payload.markdown);
    case "status":
      return service.status(undefined, await catalog.available());
    case "usage":
      return service.status();
    case "setup":
      return service.setup(payload, await catalog.available());
    case "index":
      return service.build((registries) => catalog.list(registries), background);
    case "search":
      return service.search(payload);
    case "handoff":
      return service.handoff(payload, (skill) => catalog.resolve(skill));
    default:
      throw new DiscoveryError("Unknown discovery action.");
  }
}
