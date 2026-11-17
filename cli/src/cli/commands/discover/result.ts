import type { DiscoveryStatus, Handoff, Message, Recommendation } from "#core/discovery/model.ts";
import type { SkillScore } from "#core/score/skill.ts";

/** Action-specific data inside aireg's standard JSON envelope. */
export type DiscoverResult = DiscoveryStatus | Handoff | Message | Recommendation | SkillScore;
