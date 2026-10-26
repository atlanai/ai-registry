import { gte } from "#adapter/semver.ts";
import { parse } from "#cli/options.ts";
import { unknownAction } from "#cli/suggest.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { VERSION } from "#core/version.ts";
import {
  type AutostartState,
  autostartState,
  disableAutostart,
  enableAutostart,
} from "#daemon/autostart/index.ts";
import { readDaemonPid } from "#daemon/pidfile.ts";
import { ensureDaemon, probeDaemon, stopDaemon } from "#daemon/service.ts";
import { builtin, type CommandContext, runAction } from "./index.ts";

export function daemonAction(argv: readonly string[]): string {
  for (const arg of argv) {
    if (arg === "--") break;
    if (!arg.startsWith("-")) return arg;
  }
  return "status";
}

/**
 * Commands that need the daemon start it on their own, so these exist for the
 * times you want to see it, restart it, or read what it did.
 */
export async function run(context: CommandContext): Promise<void> {
  const spec = builtin("daemon");
  parse(context.argv, spec);
  const action = daemonAction(context.argv);
  const rest = context.argv.slice(context.argv.indexOf(action) + 1);
  return runAction(
    spec,
    action,
    {
      status: () => status(context),
      start: () => start(context),
      stop: () => stop(context),
      restart: () => restart(context),
      autostart: () => autostart(context, rest),
    },
    "To manage jobs, run `aireg job`.",
  );
}

async function status(context: CommandContext): Promise<void> {
  const probe = await probeDaemon(VERSION);
  const pid = await readDaemonPid();
  const config = await readConfig();
  const enabled = config.jobs.filter((job) => job.schedule.enabled !== false).length;
  const login = await autostartState();
  const autostartOn = login?.registered === true && login.loaded;

  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: {
        status: probe.status,
        pid,
        jobs: config.jobs.length,
        enabled,
        paused: config.paused,
        autostart: autostartOn,
      },
    });
    return;
  }

  const style = context.printer.style;
  if (probe.status === "down") {
    context.printer.info("Not running.");
    context.printer.hint(
      autostartOn
        ? "Run `aireg daemon start` to start it now. Autostart starts it at login."
        : "Run `aireg daemon start` to start it now. Commands that need it start it on their own.",
    );
    return;
  }
  if (probe.status === "outdated") {
    context.printer.warning(
      `An older aireg daemon is running (pid ${probe.pid}), and this aireg cannot talk to it.`,
    );
    context.printer.hint(
      "Run `aireg daemon restart` to replace it. Commands that need it replace it on their own.",
    );
    return;
  }
  if (probe.status === "foreign") {
    context.printer.warning("Another program is listening on the daemon's socket.");
    return;
  }
  if (probe.status === "stopping") {
    context.printer.info(
      `Stopping  ${style.dim(`version ${probe.version}${pid === undefined ? "" : `, pid ${pid}`}, finishing its runs`)}`,
    );
    return;
  }

  context.printer.info(
    `Running   ${style.dim(`version ${probe.version}${pid === undefined ? "" : `, pid ${pid}`}`)}`,
  );
  context.printer.info(`Jobs      ${enabled} of ${config.jobs.length} enabled`);
  context.printer.info(`Autostart ${autostartOn ? "on" : "off"}`);
  if (config.paused) {
    context.printer.warning("Jobs are paused, so none will run.");
    context.printer.hint("Run `aireg job resume` to run them again.");
  }
}

/** What start, stop and restart leave running, for `--json`. */
async function settled(context: CommandContext, changed: boolean): Promise<void> {
  if (context.printer.format !== "json") return;
  const { status } = await probeDaemon(VERSION);
  const pid = status === "ready" ? await readDaemonPid() : undefined;
  context.printer.json({ ok: true, data: { status, pid, changed } });
}

async function start(context: CommandContext): Promise<void> {
  const before = await probeDaemon(VERSION);
  // A newer daemon is left alone: an older binary run by hand must not downgrade it.
  if (before.status === "ready" && (before.version === VERSION || gte(before.version, VERSION))) {
    context.printer.info("The daemon is already running.");
    return settled(context, false);
  }
  await ensureDaemon(VERSION);
  if (before.status === "ready") {
    context.printer.success(`Restarted the daemon: ${before.version} → ${VERSION}.`);
  } else if (before.status === "outdated") {
    context.printer.success("Replaced the older daemon.");
  } else {
    context.printer.success("Started the daemon.");
  }
  return settled(context, true);
}

async function stop(context: CommandContext): Promise<void> {
  const before = await probeDaemon(VERSION);
  if (before.status === "down") {
    context.printer.info("The daemon is not running.");
    return settled(context, false);
  }
  await stopDaemon();
  context.printer.success("Stopped the daemon.");
  return settled(context, true);
}

async function restart(context: CommandContext): Promise<void> {
  await stopDaemon();
  await ensureDaemon(VERSION);
  context.printer.success("Restarted the daemon.");
  return settled(context, true);
}

const PROFILE_HINT =
  "Run `aireg daemon start` from your shell profile instead; it does nothing when the daemon is up.";

const MECHANISM: Record<AutostartState["mechanism"], string> = {
  launchd: "launchd agent",
  systemd: "systemd user service",
  "run-key": "Windows Run key",
};

/** `on` and `off` read as a switch; `enable` and `disable` are what service managers say. */
async function autostart(context: CommandContext, argv: string[]): Promise<void> {
  const action = daemonAction(argv);
  if (action === "on" || action === "enable") return autostartEnable(context);
  if (action === "off" || action === "disable") return autostartDisable(context);
  if (action === "status") return autostartReport(context);
  throw unknownAction(
    "daemon autostart",
    action,
    ["on", "off", "status", "enable", "disable"],
    "Use on, off or status.",
  );
}

function unsupported(): AiregError {
  return new AiregError(`Autostart is not supported on ${process.platform}.`, {
    code: ErrorCode.Unavailable,
    hint: PROFILE_HINT,
  });
}

async function autostartEnable(context: CommandContext): Promise<void> {
  // A root-owned agent in a user's home never loads, and a system-wide one is not what was asked.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw new AiregError("Autostart is set per user, so it cannot be turned on as root.", {
      code: ErrorCode.Usage,
      hint: "Run it again without sudo.",
    });
  }
  let change: Awaited<ReturnType<typeof enableAutostart>>;
  try {
    change = await enableAutostart(stopDaemon);
  } catch (error) {
    throw new AiregError(`Could not turn autostart on: ${(error as Error).message}`, {
      code: ErrorCode.Unavailable,
      cause: error,
      hint: PROFILE_HINT,
    });
  }
  if (change === undefined) throw unsupported();
  await ensureDaemon(VERSION);

  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { changed: change.changed, ...change.state } });
    return;
  }
  if (!change.changed) {
    context.printer.info("Autostart is already on.");
    return;
  }
  context.printer.success(
    `Turned on autostart. The daemon now starts at login as a ${MECHANISM[change.state.mechanism]}.`,
  );
  context.printer.note("path", change.state.location);
}

async function autostartDisable(context: CommandContext): Promise<void> {
  const change = await disableAutostart();
  if (change === undefined) throw unsupported();

  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { changed: change.changed, ...change.state } });
    return;
  }
  if (!change.changed) {
    context.printer.info("Autostart is already off.");
    return;
  }
  context.printer.success(
    "Turned off autostart. Commands still start the daemon when they need it.",
  );
}

async function autostartReport(context: CommandContext): Promise<void> {
  const state = await autostartState();
  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: state === undefined ? { supported: false } : { supported: true, ...state },
    });
    return;
  }
  if (state === undefined) {
    context.printer.info(`Off. Autostart is not supported on ${process.platform}.`);
    return;
  }
  if (!state.registered) {
    context.printer.info("Off.");
    context.printer.hint("Run `aireg daemon autostart on` to start the daemon at login.");
    return;
  }
  const style = context.printer.style;
  if (!state.loaded) {
    context.printer.warning(`The ${MECHANISM[state.mechanism]} is registered but not loaded.`);
    context.printer.hint(
      state.mechanism === "launchd"
        ? "Turn it on in System Settings > General > Login Items, or run `aireg daemon autostart on`."
        : "Run `aireg daemon autostart on` to load it again.",
    );
    return;
  }
  context.printer.info(`On   ${style.dim(`${MECHANISM[state.mechanism]}, ${state.location}`)}`);
  if (!state.current) {
    context.printer.warning("Autostart starts a different install of aireg than this one.");
    context.printer.hint("Run `aireg daemon autostart on` to point it at this one.");
  }
}
