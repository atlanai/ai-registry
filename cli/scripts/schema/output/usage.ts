import { Type } from "@sinclair/typebox";
import type {
  UsageReport,
  UsageSendResult,
  UsageShareList,
  UsageShareResult,
} from "#cli/commands/usage/result.ts";
import { matching, outputDocument } from "./match.ts";

const Sharing = Type.Object(
  {
    registry: Type.String({ description: "The registry's alias." }),
    otlp: Type.String({ description: "The OpenTelemetry endpoint runs are sent to." }),
    as: Type.Union([Type.String(), Type.Null()], {
      description: "The name you chose; `null` when the registry gets a pseudonym.",
    }),
  },
  { additionalProperties: false },
);

const Report = matching<UsageReport>()(
  Type.Object(
    {
      days: Type.Integer({ minimum: 1 }),
      artifacts: Type.Array(
        Type.Object(
          {
            registry: Type.String(),
            ref: Type.String({ description: "`<namespace>/<kind>/<name>@<version>`." }),
            runs: Type.Integer({ minimum: 1 }),
            byYou: Type.Integer({ minimum: 0, description: "Runs you started yourself." }),
            targets: Type.Array(Type.String()),
            last: Type.String({ description: "When it last ran, ISO 8601." }),
          },
          { additionalProperties: false },
        ),
      ),
      sharing: Type.Array(Sharing),
    },
    { additionalProperties: false },
  ),
);

const Share = matching<UsageShareResult | UsageShareList>()(
  Type.Union([
    Type.Object(
      {
        registry: Type.String(),
        otlp: Type.String(),
        sharing: Type.Boolean({ description: "`false` once sharing is turned off." }),
        reporter: Type.Union([Type.Literal("pseudonym"), Type.Literal("name")]),
        as: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    Type.Object({ sharing: Type.Array(Sharing) }, { additionalProperties: false }),
  ]),
);

const Send = matching<UsageSendResult>()(
  Type.Object(
    {
      registries: Type.Array(
        Type.Object(
          {
            registry: Type.String(),
            otlp: Type.String(),
            sent: Type.Integer({ minimum: 0 }),
            pending: Type.Integer({ minimum: 0 }),
            stopped: Type.Union([Type.String(), Type.Null()], {
              description: "Why nothing more was sent; `null` when everything went.",
            }),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
);

export const OUTPUT = outputDocument("usage", { show: Report, share: Share, send: Send });
