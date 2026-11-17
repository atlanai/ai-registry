import type { Skill } from "./retrieval.ts";
import type { UsageEvent } from "./store.ts";

export interface Recommendation {
  requestId: string;
  warnings: string[];
  status: "recommended" | "none" | "clarify";
  confidence: number | null;
  candidates: Skill[];
  selected: Skill | null;
}
export interface Job {
  running: boolean;
  done: number;
  total: number;
  error: string;
}
export interface DiscoveryStatus {
  busy: boolean;
  connected: boolean;
  registries: string[];
  telemetry: boolean;
  telemetryWarning: string;
  events: UsageEvent[];
  available: string[];
  eligible: number;
  indexed: number;
  job: Job;
  embeddingModel: string;
  decisionModel: string;
}
export interface Message {
  message: string;
}
export interface Handoff {
  handoff: {
    schema: "aireg.skill-handoff.v1";
    requestId: string;
    skill: Omit<Skill, "description">;
    instruction: string;
  };
}
