import { list, quoted } from "#adapter/text.ts";
import type {
  UsageArtifact,
  UsageReport,
  UsageSendResult,
  UsageShareList,
  UsageShareResult,
  UsageSharing,
} from "#cli/commands/usage/result.ts";
import { USAGE_COMMAND } from "#cli/commands/usage/spec.ts";
import { needsInput, parse } from "#cli/options/parse.ts";
import type { UsageShare } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode, ExitCode } from "#core/errors.ts";
import { ago } from "#core/term/format.ts";
import type { Printer } from "#core/term/printer.ts";
import { table } from "#core/term/table.ts";
import { collect } from "#engine/usage/collect.ts";
import type { Run } from "#engine/usage/model.ts";
import { send } from "#engine/usage/send.ts";
import { shareWith, stopSharing } from "#engine/usage/share.ts";
import { action, defineCommand } from "./define.ts";

const DAY_MS = 86_400_000;

interface Own extends Record<string, unknown> {
  days?: number;
  as?: string;
  off?: boolean;
}

interface Options {
  registry: string | undefined;
  own: Own;
}

export const { run } = defineCommand<Options>({
  spec: USAGE_COMMAND,
  parse(argv) {
    const { positionals, own } = parse<Own>(argv, USAGE_COMMAND);
    const [verb = "show", registry] = positionals;
    return { action: verb, options: { registry, own } };
  },
  actions: {
    show: action({
      run: async ({ own }): Promise<UsageReport> => {
        const days = own.days ?? 30;
        const { runs } = await collect();
        return {
          days,
          artifacts: tally(runs, Date.now() - days * DAY_MS),
          sharing: sharingOf(await shares()),
        };
      },
      text: showText,
    }),
    share: action({
      run: async ({ registry, own }, context): Promise<UsageShareResult | UsageShareList> => {
        if (registry === undefined) {
          if (own.off === true || own.as !== undefined) {
            throw needsInput(
              "usage share",
              "a registry",
              "Name it: `aireg usage share <registry>`.",
            );
          }
          return { sharing: sharingOf(await shares()) };
        }
        if (own.off === true) {
          const stopped = await stopSharing(registry);
          if (stopped === undefined) {
            throw new AiregError(`You do not share usage with ${quoted(registry)}.`, {
              code: ErrorCode.Usage,
              hint: "Run `aireg usage share` to see the registries you share with.",
            });
          }
          return {
            registry,
            otlp: stopped.otlp,
            sharing: false,
            reporter: reporterOf(stopped),
            as: stopped.as ?? null,
          };
        }
        const { share, usage } = await shareWith(registry, own.as, context.cwd);
        return {
          registry,
          otlp: share.otlp,
          sharing: true,
          reporter: usage.reporter,
          as: share.as ?? null,
        };
      },
      text: (result, printer) => {
        if ("sharing" in result && Array.isArray(result.sharing)) listText(result.sharing, printer);
        else shareText(result as UsageShareResult, printer);
      },
    }),
    send: action({
      run: async (_, context): Promise<UsageSendResult> => {
        const registries = (await send()).map((item) => ({
          registry: item.alias,
          otlp: item.otlp,
          sent: item.sent,
          pending: item.pending,
          stopped: item.stopped ?? null,
        }));
        if (registries.some((item) => item.stopped !== null)) context.exit = ExitCode.Error;
        return { registries };
      },
      text: sendText,
      ok: (result) => result.registries.every((item) => item.stopped === null),
    }),
  },
});

async function shares(): Promise<readonly UsageShare[]> {
  return (await readConfig()).usage;
}

function sharingOf(held: readonly UsageShare[]): UsageSharing[] {
  return held.map((share) => ({ registry: share.alias, otlp: share.otlp, as: share.as ?? null }));
}

function reporterOf(share: UsageShare): "pseudonym" | "name" {
  return share.as === undefined ? "pseudonym" : "name";
}

/** Runs since `since`, one row per version, busiest first. */
function tally(runs: readonly Run[], since: number): UsageArtifact[] {
  const rows = new Map<string, UsageArtifact & { seen: Set<string> }>();
  for (const run of runs) {
    if (Date.parse(run.at) < since) continue;
    const key = `${run.registry}\0${run.ref}`;
    const row = rows.get(key) ?? {
      registry: run.alias,
      ref: run.ref,
      runs: 0,
      byYou: 0,
      targets: [],
      last: run.at,
      seen: new Set<string>(),
    };
    row.runs += 1;
    if (run.trigger === "person") row.byYou += 1;
    row.seen.add(run.target);
    if (run.at > row.last) row.last = run.at;
    rows.set(key, row);
  }
  return [...rows.values()]
    .map(({ seen, ...row }) => ({ ...row, targets: [...seen].sort() }))
    .sort((a, b) => b.runs - a.runs || a.ref.localeCompare(b.ref));
}

function showText(result: UsageReport, printer: Printer): void {
  const { style } = printer;
  if (result.artifacts.length === 0) {
    printer.info(`No runs of an installed skill or agent in the last ${result.days} days.`);
    printer.hint("aireg counts what Claude Code and Codex record; install with `aireg add` first.");
  } else {
    const total = result.artifacts.reduce((sum, row) => sum + row.runs, 0);
    printer.info(
      style.bold(
        `${total} ${total === 1 ? "run" : "runs"} in the last ${result.days} days, on this machine`,
      ),
    );
    table(
      printer,
      [
        { header: "artifact", value: (row: UsageArtifact) => row.ref },
        { header: "from", value: (row: UsageArtifact) => row.registry },
        { header: "runs", value: (row: UsageArtifact) => String(row.runs) },
        { header: "by you", value: (row: UsageArtifact) => String(row.byYou) },
        { header: "in", value: (row: UsageArtifact) => row.targets.join(", ") },
        { header: "last", value: (row: UsageArtifact) => ago(Date.parse(row.last)) },
      ],
      result.artifacts,
    );
  }
  printer.info();
  if (result.sharing.length === 0) {
    printer.hint(
      "These counts stay on this machine. For a registry that asks for usage, `aireg usage share <registry>` sends it its runs.",
    );
    return;
  }
  for (const share of result.sharing) printer.note("sharing", `${share.registry} → ${share.otlp}`);
}

function listText(sharing: readonly UsageSharing[], printer: Printer): void {
  if (sharing.length === 0) {
    printer.info("You share usage with no registry.");
    printer.hint("Run `aireg usage share <registry>` for one whose registry.json asks for usage.");
    return;
  }
  for (const share of sharing) {
    const as = share.as === null ? "as a pseudonym" : `as ${share.as}`;
    printer.info(`${share.registry} → ${share.otlp} ${printer.style.dim(as)}`);
  }
}

function shareText(result: UsageShareResult, printer: Printer): void {
  if (!result.sharing) {
    printer.success(`Stopped sending usage to ${result.registry}.`);
    printer.hint("Runs already sent stay with the endpoint; ask its owner to remove them.");
    return;
  }
  const who = result.as === null ? "a pseudonym for you" : `your name, ${result.as}`;
  printer.success(`Sending runs of ${result.registry}'s skills and agents to ${result.otlp}.`);
  printer.info(
    `Each run sends the version that ran, the coding agent, when it ran and ${who}. ` +
      "Never a prompt, an answer, a file path or a project name.",
  );
  printer.hint(
    `Runs from now on are sent. \`aireg usage share ${result.registry} --off\` stops it.`,
  );
}

function sendText(result: UsageSendResult, printer: Printer): void {
  if (result.registries.length === 0) {
    printer.info("You share usage with no registry, so nothing was sent.");
    printer.hint("Run `aireg usage share <registry>` for one whose registry.json asks for usage.");
    return;
  }
  for (const item of result.registries) {
    const sent = `${item.sent} ${item.sent === 1 ? "run" : "runs"}`;
    if (item.stopped === null) {
      printer.success(`${item.registry}: sent ${sent} to ${item.otlp}.`);
      continue;
    }
    printer.warning(
      `${item.registry}: sent ${sent}; ${item.pending} not sent, because ${item.stopped}.`,
    );
  }
  const moved = result.registries.filter((item) => item.stopped?.includes("not agreed") === true);
  if (moved.length > 0) {
    printer.hint(
      `Run ${list(
        moved.map((item) => `\`aireg usage share ${item.registry}\``),
        "and",
      )} to agree to where it sends usage now.`,
    );
  }
}
