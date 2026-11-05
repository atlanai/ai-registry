import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnDetached } from "#core/process.ts";
import { DOCS_URL, TELEMETRY_FLAG, TELEMETRY_NOTICE_FILE } from "#core/product.ts";
import { launchArgv, runningEntry } from "#core/release/launch.ts";
import { ensureHome } from "#core/store/paths.ts";
import type { Printer } from "#core/term/printer.ts";
import type { Queued } from "./model.ts";
import { savedTelemetryState, telemetryState } from "./state.ts";

const pending: Queued[] = [];

export function queue(item: Queued): void {
  if (telemetryState().on) pending.push(item);
}

/** Bumped when the notice says something materially new, so it is shown again. */
const NOTICE_VERSION = "1";

/**
 * Shown once per aireg home before anything is sent: the run that shows it sends
 * nothing, so a person can turn events off before the first one leaves.
 */
export async function noticeFirst(
  printer: Printer,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!(await savedTelemetryState(env)).on) return;
  try {
    const file = join(ensureHome(env), TELEMETRY_NOTICE_FILE);
    const shown = (await readFile(file, "utf8").catch(() => "")).trim();
    if (shown === NOTICE_VERSION) return;
    printer.notice(
      [
        "aireg collects usage data to improve the CLI. Events never include your identity.",
        `  Learn more, including how to opt out: ${DOCS_URL}reference/environment/#network-and-privacy`,
      ].join("\n"),
    );
    await writeFile(file, `${NOTICE_VERSION}\n`, { mode: 0o600 });
  } catch {
    // A home that cannot be written to shows the notice again next time.
  }
  pending.splice(0);
}

/** Hands what the command queued to a detached sender, so no command waits on the network. */
export async function flushTelemetry(
  entry = runningEntry(),
  $spawn: typeof spawnDetached = spawnDetached,
): Promise<void> {
  const items = pending.splice(0);
  if (items.length === 0 || entry === undefined) return;
  if (!(await savedTelemetryState()).on) return;
  try {
    const launch = launchArgv(entry, [TELEMETRY_FLAG]);
    const child = $spawn(launch.command, launch.args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    await new Promise<void>((resolve) => {
      child.stdin?.on("error", () => resolve());
      child.stdin?.end(JSON.stringify(items), () => resolve());
    });
  } catch {
    // Telemetry never fails a command.
  }
}
