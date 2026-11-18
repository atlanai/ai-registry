import { Type } from "@sinclair/typebox";
import type { DiscoverResult } from "#cli/commands/discover/result.ts";
import { matching, outputDocument } from "./match.ts";

const Identity = {
  key: Type.String(),
  name: Type.String(),
  registry: Type.String(),
  namespace: Type.String(),
  version: Type.String(),
  digest: Type.String(),
};
const Skill = Type.Object(
  { ...Identity, description: Type.String() },
  { additionalProperties: false },
);
const Message = Type.Object({ message: Type.String() }, { additionalProperties: false });
const Handoff = Type.Object(
  {
    handoff: Type.Object(
      {
        schema: Type.Literal("aireg.skill-handoff.v1"),
        requestId: Type.String(),
        skill: Type.Object(Identity, { additionalProperties: false }),
        instruction: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const Search = Type.Object(
  {
    requestId: Type.String(),
    warnings: Type.Array(Type.String()),
    status: Type.Union([
      Type.Literal("recommended"),
      Type.Literal("none"),
      Type.Literal("clarify"),
    ]),
    confidence: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
    candidates: Type.Array(Skill, { maxItems: 8 }),
    selected: Type.Union([Skill, Type.Null()]),
  },
  { additionalProperties: false },
);
const Status = Type.Object(
  {
    busy: Type.Boolean(),
    connected: Type.Boolean(),
    registries: Type.Array(Type.String()),
    telemetry: Type.Boolean(),
    telemetryWarning: Type.String(),
    available: Type.Array(Type.String()),
    eligible: Type.Number(),
    indexed: Type.Number(),
    indexReady: Type.Boolean(),
    indexedAt: Type.Union([Type.String(), Type.Null()]),
    embeddingModel: Type.String(),
    decisionModel: Type.String(),
    job: Type.Object(
      { running: Type.Boolean(), done: Type.Number(), total: Type.Number(), error: Type.String() },
      { additionalProperties: false },
    ),
    events: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          at: Type.String(),
          type: Type.Union(
            ["search", "recommendation", "handoff", "feedback", "error"].map((v) =>
              Type.Literal(v as "search" | "recommendation" | "handoff" | "feedback" | "error"),
            ),
          ),
          requestId: Type.String(),
          skillKey: Type.String(),
          skillVersion: Type.Optional(Type.String()),
          skillDigest: Type.Optional(Type.String()),
          durationMs: Type.Number(),
          outcome: Type.String(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 1000 },
    ),
  },
  { additionalProperties: false },
);
const Score = Type.Object(
  {
    rubric: Type.Literal("authoring-signals-v1"),
    status: Type.Union([Type.Literal("scored"), Type.Literal("unavailable")]),
    score: Type.Union([Type.Number(), Type.Null()]),
    digest: Type.String(),
    checks: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          label: Type.String(),
          points: Type.Number(),
          earned: Type.Number(),
          evidence: Type.String(),
          improvement: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    review: Type.Array(Type.String()),
    safety: Type.Literal("not-assessed"),
    performance: Type.Literal("not-measured"),
  },
  { additionalProperties: false },
);
matching<DiscoverResult>()(Type.Union([Status, Handoff, Message, Search, Score]));
export const OUTPUT = outputDocument("discover", {
  status: Status,
  usage: Status,
  setup: Message,
  index: Message,
  search: Search,
  handoff: Handoff,
  feedback: Message,
  telemetry: Message,
  clear: Message,
  disconnect: Message,
  score: Score,
});
