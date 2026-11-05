import { Type } from "@sinclair/typebox";
import type { LogsResult } from "#cli/commands/logs/result.ts";
import { LEVELS } from "#core/log/model.ts";
import { matching, oneOf, outputDocument } from "./match.ts";

const SerializedError = Type.Recursive((Self) =>
  Type.Object(
    {
      name: Type.String(),
      message: Type.String(),
      code: Type.Optional(Type.String()),
      stack: Type.Optional(Type.String()),
      cause: Type.Optional(Self),
    },
    { additionalProperties: false },
  ),
);

const LogRecord = Type.Object(
  {
    timestamp: Type.String({ description: "An RFC 3339 time in UTC." }),
    severity_text: oneOf(LEVELS),
    severity_number: Type.Number(),
    body: Type.String(),
    attributes: Type.Record(Type.String(), Type.Unknown()),
    error: Type.Optional(SerializedError),
  },
  { additionalProperties: false, description: "One record, in the OTel log data model." },
);

const RawLine = Type.Object(
  { raw: Type.String() },
  { additionalProperties: false, description: "A line that is not a record, kept whole." },
);

const Logs = matching<LogsResult>()(
  Type.Object(
    {
      entries: Type.Array(
        Type.Object(
          {
            log: Type.Union([Type.Literal("daemon"), Type.Literal("cli"), Type.Literal("stderr")]),
            entry: Type.Union([LogRecord, RawLine]),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
);

export const OUTPUT = outputDocument("logs", { logs: Logs });
