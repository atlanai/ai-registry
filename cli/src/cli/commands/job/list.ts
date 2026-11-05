import { plural } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { typedFolder } from "#cli/commands/job/find.ts";
import { underHome } from "#cli/render/home.ts";
import { watchedFolders } from "#core/config/jobs.ts";
import type { Job } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { stepContribution } from "#core/host/load.ts";
import { shortDuration } from "#core/term/format.ts";
import { table } from "#core/term/table.ts";
import type { Own } from "./options.ts";

export async function list(context: CommandContext): Promise<void> {
  const config = await readConfig();
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { paused: config.paused, jobs: config.jobs } });
    return;
  }
  if (config.paused) context.printer.info("Jobs are paused, so none runs on its schedule.");
  if (config.jobs.length === 0) {
    context.printer.info("No jobs yet.");
    context.printer.hint("Run `aireg job add` to add one.");
    return;
  }
  const named = new Map(config.accounts.map((item) => [item.id, item.registry]));
  const rows = await Promise.all(config.jobs.map((job) => describe(job, named)));
  const { style } = context.printer;
  context.printer.info(style.bold(plural(rows.length, "job")));
  table(
    context.printer,
    [
      { header: "job", value: (row: Described) => row.job },
      { header: "registry", value: (row: Described) => row.registry },
      { header: "folder", value: (row: Described) => row.root },
      { header: "every", value: (row: Described) => shortDuration(row.every) },
      {
        header: "state",
        value: (row: Described) =>
          row.enabled ? style.green("enabled") : style.yellow("disabled"),
      },
      { header: "steps", value: (row: Described) => style.dim(row.steps) },
    ],
    rows,
  );
}

interface Described {
  job: string;
  registry: string;
  root: string;
  every: number;
  enabled: boolean;
  steps: string;
}

async function describe(job: Job, named: ReadonlyMap<string, string>): Promise<Described> {
  const registry = named.get(job.account) ?? job.account;
  const steps = await Promise.all(
    job.steps.map(async (step) => {
      const handler = await stepContribution(step.kind);
      return handler?.describe === undefined ? step.name : handler.describe(step, registry);
    }),
  );
  return {
    job: job.name ?? job.id,
    registry,
    root: target(job),
    every: job.schedule.every,
    enabled: job.schedule.enabled,
    steps: steps.join(" → "),
  };
}

export function target(job: Job): string {
  const watched = watchedFolders(job).map(underHome);
  if (watched.length > 0) return watched.join(", ");
  const rooted = job.steps.find((step) => step.root !== undefined);
  return rooted?.root === undefined
    ? job.steps.map((step) => step.kind).join("+")
    : underHome(rooted.root);
}

/** `~` is kept for the daemon to expand. */
export function originsOf(own: Own, cwd: string): { to: string; from: string[] } | undefined {
  const watched = own.watch ?? [];
  if (watched.length === 0) return undefined;
  if (own.to === undefined || !/^[^/\s]+\/[^/\s]+$/.test(own.to)) {
    throw new AiregError("--watch needs --to <registry>/<namespace>.", {
      code: ErrorCode.Usage,
      hint: "Name where to publish: `aireg job add --watch <folder> --to <registry>/<namespace>`.",
    });
  }
  return { to: own.to, from: watched.map((folder) => typedFolder(folder, cwd)) };
}
