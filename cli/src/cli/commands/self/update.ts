import { gte } from "#adapter/semver.ts";
import type { SelfUpdate } from "#cli/commands/self/result.ts";
import { withReleaseHint } from "#core/release/errors.ts";
import { shimPath, versionBin } from "#core/release/layout.ts";
import type { Printer } from "#core/term/printer.ts";
import { VERSION } from "#core/version.ts";
import { recycleDaemon } from "#daemon/process/lifecycle.ts";
import { installedVersion, previousInstalled, rollback } from "#self/install.ts";
import { installRelease } from "#self/minimum-update.ts";
import { resolveRelease } from "#self/release.ts";
import { cacheFrom, writeUpdateCache } from "#self/update-cache.ts";

interface Options {
  dryRun: boolean;
  force: boolean;
  check: boolean;
  rollback: boolean;
}

export async function update(options: Options): Promise<SelfUpdate> {
  try {
    return await execute(options);
  } catch (error) {
    throw withReleaseHint(
      error,
      "Run `aireg doctor` to see the release channel this build updates from.",
    );
  }
}

async function execute({ dryRun, force, check, rollback: back }: Options): Promise<SelfUpdate> {
  if (back) {
    if (dryRun) {
      return {
        current: VERSION,
        latest: await previousInstalled(),
        action: "would-rollback",
        dryRun,
      };
    }
    const version = await rollback();
    await recycleDaemon(versionBin(version), version);
    return { current: VERSION, latest: version, action: "rolled-back", dryRun };
  }

  const current = await installedVersion();
  const release = await resolveRelease();
  // What `aireg doctor` reads; the background check never runs for `aireg self`.
  await writeUpdateCache(cacheFrom(release, Date.now())).catch(() => undefined);
  const upToDate = gte(current, release.version);

  if (check || dryRun) {
    return {
      current,
      latest: release.version,
      action: upToDate ? "already-latest" : dryRun ? "would-update" : "update-available",
      dryRun,
    };
  }

  if (upToDate && !force) {
    return { current, latest: release.version, action: "already-latest", dryRun };
  }

  await installRelease(release);
  await recycleDaemon(versionBin(release.version), release.version);
  return {
    current: release.version,
    latest: release.version,
    action: "updated",
    bin: shimPath(),
    dryRun,
  };
}

export function printUpdate(result: SelfUpdate, printer: Printer): void {
  if (result.action === "already-latest") {
    printer.info(`aireg ${result.current} is up to date.`);
    return;
  }
  if (result.action === "would-update") {
    printer.info(`Would update aireg ${result.current} → ${result.latest}.`);
    return;
  }
  if (result.action === "update-available") {
    printer.info(`aireg ${result.latest} is available (you have ${result.current}).`);
    printer.note("next", "aireg self update");
    return;
  }
  if (result.action === "would-rollback") {
    printer.info(`Would roll back to aireg ${result.latest}.`);
    return;
  }
  if (result.action === "rolled-back") {
    printer.success(`Rolled back to aireg ${result.latest}.`);
    return;
  }
  printer.success(`Updated to aireg ${result.latest}.`);
  if (result.bin !== undefined) printer.note("path", result.bin);
}
