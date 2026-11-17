import { type SkillScore, scoreSkill } from "#core/score/skill.ts";
import { DiscoveryError } from "./gemini.ts";
import type { DiscoveryStatus, Handoff, Message, Recommendation } from "./model.ts";
import type { Skill } from "./retrieval.ts";
import type { Discovery } from "./service.ts";

/** Shared operation dispatch; transports supply inputs and a catalog, never business rules. */
export async function discover(
  service: Discovery,
  action: string,
  payload: Record<string, unknown>,
  catalog: () => Promise<Skill[]>,
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
    case "usage":
      return service.status(await catalog());
    case "setup":
      return service.setup(payload, await catalog());
    case "index":
      return service.build(await catalog(), background);
    case "search":
      return service.search(payload, await catalog());
    case "handoff":
      return service.handoff(payload, await catalog());
    default:
      throw new DiscoveryError("Unknown discovery action.");
  }
}
