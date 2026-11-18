import { isRecord } from "#adapter/fields.ts";
import type { DiscoverResult } from "#cli/commands/discover/result.ts";
import { DISCOVER_COMMAND } from "#cli/commands/discover/spec.ts";
import { discoveryCatalog } from "#cli/discovery/catalog.ts";
import { parse } from "#cli/options/parse.ts";
import { discover } from "#core/discovery/actions.ts";
import { Discovery, safeError } from "#core/discovery/service.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { defineCommand } from "./define.ts";

function usage(message: string): never {
  throw new AiregError(message, { code: ErrorCode.Usage, hint: "Run `aireg discover --help`." });
}

/** Bounded pipe input. Never echoes the input or a parser error that may contain a key. */
async function input(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) usage("--input-stdin reads a pipe, not the terminal.");
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 300 * 1024) usage("Discovery input is too large.");
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw new Error();
    return value;
  } catch {
    return usage("Discovery input must be a JSON object.");
  }
}

export const { run } = defineCommand({
  spec: DISCOVER_COMMAND,
  parse(argv) {
    const { positionals, own } = parse<{ "input-stdin"?: boolean }>(argv, DISCOVER_COMMAND);
    const [action = "status", ...args] = positionals;
    if (!DISCOVER_COMMAND.actions?.some((a) => a.name === action))
      usage("Unknown discovery action.");
    const piped = own["input-stdin"] === true;
    if (piped && args.length) usage("Use arguments or --input-stdin, not both.");
    if (["setup", "score"].includes(action) && !piped) usage("This action requires --input-stdin.");
    if (["handoff", "feedback"].includes(action) && !args[0])
      usage("Supply the search request ID.");
    if (action === "feedback" && !["helpful", "not_helpful"].includes(args[1] ?? ""))
      usage("Choose helpful or not_helpful feedback.");
    if (action === "telemetry" && !["on", "off"].includes(args[0] ?? ""))
      usage("Choose telemetry on or off.");
    return { action, args, piped };
  },
  async run({ action, args, piped }, context): Promise<DiscoverResult> {
    const payload = piped
      ? await input()
      : {
          query: args.join(" "),
          requestId: args[0],
          outcome: args[1],
          enabled: args[0] === "on",
        };
    try {
      return await discover(new Discovery(), action, payload, discoveryCatalog(context));
    } catch (error) {
      throw new AiregError(safeError(error), { code: ErrorCode.Invalid });
    }
  },
  text(result, printer) {
    if ("message" in result && typeof result.message === "string") printer.info(result.message);
    else printer.info(JSON.stringify(result, null, 2));
  },
});
