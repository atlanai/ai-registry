import { gte } from "#adapter/semver.ts";
import { actionOf, type CommandContext } from "#cli/commands/command.ts";
import { parse } from "#cli/options/parse.ts";
import { withReleaseHint } from "#core/release/errors.ts";
import { shimPath, versionBin } from "#core/release/layout.ts";
import { VERSION } from "#core/version.ts";
import { recycleDaemon } from "#daemon/process/lifecycle.ts";
import { installedVersion, previousInstalled, rollback } from "#self/install.ts";
import { installRelease } from "#self/minimum-update.ts";
import { resolveRelease } from "#self/release.ts";
import { cacheFrom, writeUpdateCache } from "#self/update-cache.ts";
import { SELF_COMMAND } from "./spec.ts";

interface Own extends Record<string, unknown> {
  check?: boolean;
  rollback?: boolean;
}

export async function run(context: CommandContext): Promise<void> {
  const { common, own } = parse<Own>(context.argv, actionOf(SELF_COMMAND, "update"));

  try {
    await execute(context, common.dryRun, common.force, own);
  } catch (error) {
    throw withReleaseHint(
      error,
      "Run `aireg doctor` to see the release channel this build updates from.",
    );
  }
}

async function execute(
  context: CommandContext,
  dryRun: boolean,
  force: boolean,
  own: Own,
): Promise<void> {
  if (own.rollback === true) {
    if (dryRun) {
      report(context, dryRun, {
        current: VERSION,
        latest: await previousInstalled(),
        action: "would-rollback",
      });
      return;
    }
    const version = await rollback();
    await recycleDaemon(versionBin(version), version);
    report(context, dryRun, { current: VERSION, latest: version, action: "rolled-back" });
    return;
  }

  const current = await installedVersion();
  const release = await resolveRelease();
  // What `aireg doctor` reads; the background check never runs for `aireg self`.
  await writeUpdateCache(cacheFrom(release, Date.now())).catch(() => undefined);
  const upToDate = gte(current, release.version);

  if (own.check === true || dryRun) {
    report(context, dryRun, {
      current,
      latest: release.version,
      action: upToDate ? "already-latest" : dryRun ? "would-update" : "update-available",
    });
    return;
  }

  if (upToDate && !force) {
    report(context, dryRun, {
      current,
      latest: release.version,
      action: "already-latest",
    });
    return;
  }

  await installRelease(release);
  await recycleDaemon(versionBin(release.version), release.version);
  report(context, dryRun, {
    current: release.version,
    latest: release.version,
    action: "updated",
    bin: shimPath(),
  });
}

function report(
  context: CommandContext,
  dryRun: boolean,
  data: {
    current: string;
    latest: string;
    action: string;
    bin?: string | undefined;
  },
): void {
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { ...data, dryRun } });
    return;
  }
  if (data.action === "already-latest") {
    context.printer.info(`aireg ${data.current} is up to date.`);
    return;
  }
  if (data.action === "would-update") {
    context.printer.info(`Would update aireg ${data.current} → ${data.latest}.`);
    return;
  }
  if (data.action === "update-available") {
    context.printer.info(`aireg ${data.latest} is available (you have ${data.current}).`);
    context.printer.note("next", "aireg self update");
    return;
  }
  if (data.action === "would-rollback") {
    context.printer.info(`Would roll back to aireg ${data.latest}.`);
    return;
  }
  if (data.action === "rolled-back") {
    context.printer.success(`Rolled back to aireg ${data.latest}.`);
    return;
  }
  context.printer.success(`Updated to aireg ${data.latest}.`);
  if (data.bin !== undefined) context.printer.note("path", data.bin);
}
