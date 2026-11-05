import { messageOf } from "#adapter/errors.ts";
import { gte } from "#adapter/semver.ts";
import type { DaemonAutostart, DaemonSettled, DaemonStatus } from "#cli/commands/daemon/result.ts";
import { DAEMON_COMMAND } from "#cli/commands/daemon/spec.ts";
import { parse } from "#cli/options/parse.ts";
import { unknownAction } from "#cli/options/suggest.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { Printer } from "#core/term/printer.ts";
import { VERSION } from "#core/version.ts";
import {
  type AutostartChange,
  autostartState,
  disableAutostart,
  enableAutostart,
} from "#daemon/autostart/index.ts";
import type { AutostartState } from "#daemon/autostart/model.ts";
import {
  type DaemonProbe,
  ensureDaemon,
  probeDaemon,
  stopDaemon,
} from "#daemon/process/lifecycle.ts";
import { readDaemonPid } from "#daemon/process/pid-file.ts";
import { action, defineCommand } from "./define.ts";

interface Options {
  autostart: string;
}

interface StatusRead {
  probe: DaemonProbe;
  pid: number | undefined;
  jobs: number;
  enabled: number;
  paused: boolean;
  autostart: boolean;
}

interface Settled {
  status: DaemonProbe["status"];
  pid: number | undefined;
  changed: boolean;
}

interface Started extends Settled {
  before: DaemonProbe;
}

type Autostart =
  | { turned: "on" | "off"; change: AutostartChange }
  | { report: AutostartState | undefined };

export const { run } = defineCommand<Options>({
  spec: DAEMON_COMMAND,
  more: "To manage jobs, run `aireg job`.",
  parse(argv) {
    parse(argv, DAEMON_COMMAND);
    const chosen = daemonAction(argv);
    const rest = argv.slice(argv.indexOf(chosen) + 1);
    return { action: chosen, options: { autostart: daemonAction(rest) } };
  },
  actions: {
    status: action({
      async run(): Promise<StatusRead> {
        const probe = await probeDaemon(VERSION);
        const pid = await readDaemonPid();
        const config = await readConfig();
        const login = await autostartState();
        return {
          probe,
          pid,
          jobs: config.jobs.length,
          enabled: config.jobs.filter((job) => job.schedule.enabled !== false).length,
          paused: config.paused,
          autostart: login?.registered === true && login.loaded,
        };
      },
      data: (read): DaemonStatus => ({
        status: read.probe.status,
        ...(read.pid === undefined ? {} : { pid: read.pid }),
        jobs: read.jobs,
        enabled: read.enabled,
        paused: read.paused,
        autostart: read.autostart,
      }),
      text: statusText,
    }),
    start: action<Options, Started>({
      async run(): Promise<Started> {
        const before = await probeDaemon(VERSION);
        // A newer daemon is left alone: an older binary run by hand must not downgrade it.
        if (
          before.status === "ready" &&
          (before.version === VERSION || gte(before.version, VERSION))
        ) {
          return { ...(await settled(false)), before };
        }
        await ensureDaemon(VERSION);
        return { ...(await settled(true)), before };
      },
      data: settledData,
      text({ changed, before }, printer) {
        if (!changed) printer.info("The daemon is already running.");
        else if (before.status === "ready") {
          printer.success(`Restarted the daemon: ${before.version} → ${VERSION}.`);
        } else if (before.status === "outdated") printer.success("Replaced the older daemon.");
        else printer.success("Started the daemon.");
      },
    }),
    stop: action({
      async run(): Promise<Settled> {
        if ((await probeDaemon(VERSION)).status === "down") return settled(false);
        await stopDaemon();
        return settled(true);
      },
      data: settledData,
      text: ({ changed }, printer) =>
        changed
          ? printer.success("Stopped the daemon.")
          : printer.info("The daemon is not running."),
    }),
    restart: action({
      async run(): Promise<Settled> {
        await stopDaemon();
        await ensureDaemon(VERSION);
        return settled(true);
      },
      data: settledData,
      text: (_, printer) => printer.success("Restarted the daemon."),
    }),
    // `on` and `off` read as a switch; `enable` and `disable` are what service managers say.
    autostart: action({
      async run({ autostart: word }): Promise<Autostart> {
        if (word === "on" || word === "enable") {
          return { turned: "on", change: await autostartEnable() };
        }
        if (word === "off" || word === "disable") {
          return { turned: "off", change: await autostartDisable() };
        }
        if (word === "status") return { report: await autostartState() };
        throw unknownAction(
          "daemon autostart",
          word,
          ["on", "off", "status", "enable", "disable"],
          "Use on, off or status.",
        );
      },
      data: (result): DaemonAutostart => {
        if ("change" in result) return { changed: result.change.changed, ...result.change.state };
        return result.report === undefined
          ? { supported: false }
          : { supported: true, ...result.report };
      },
      text(result, printer) {
        if ("report" in result) autostartReport(result.report, printer);
        else if (result.turned === "on") switchedOn(result.change, printer);
        else switchedOff(result.change, printer);
      },
    }),
  },
});

export function daemonAction(argv: readonly string[]): string {
  for (const arg of argv) {
    if (arg === "--") break;
    if (!arg.startsWith("-")) return arg;
  }
  return "status";
}

function statusText(read: StatusRead, printer: Printer): void {
  const { probe, pid } = read;
  const style = printer.style;
  if (probe.status === "down") {
    printer.info("Not running.");
    printer.hint(
      read.autostart
        ? "Run `aireg daemon start` to start it now. Autostart starts it at login."
        : "Run `aireg daemon start` to start it now. Commands that need it start it on their own.",
    );
    return;
  }
  if (probe.status === "outdated") {
    printer.warning(
      `An older aireg daemon is running (pid ${probe.pid}), and this aireg cannot talk to it.`,
    );
    printer.hint(
      "Run `aireg daemon restart` to replace it. Commands that need it replace it on their own.",
    );
    return;
  }
  if (probe.status === "foreign") {
    printer.warning("Another program is listening on the daemon's socket.");
    return;
  }
  if (probe.status === "stopping") {
    printer.info(
      `Stopping  ${style.dim(`version ${probe.version}${pid === undefined ? "" : `, pid ${pid}`}, finishing its runs`)}`,
    );
    return;
  }

  printer.info(
    `Running   ${style.dim(`version ${probe.version}${pid === undefined ? "" : `, pid ${pid}`}`)}`,
  );
  printer.info(`Jobs      ${read.enabled} of ${read.jobs} enabled`);
  printer.info(`Autostart ${read.autostart ? "on" : "off"}`);
  if (read.paused) {
    printer.warning("Jobs are paused, so none will run.");
    printer.hint("Run `aireg job resume` to run them again.");
  }
}

async function settled(changed: boolean): Promise<Settled> {
  const { status } = await probeDaemon(VERSION);
  const pid = status === "ready" ? await readDaemonPid() : undefined;
  return { status, pid, changed };
}

function settledData({ status, pid, changed }: Settled): DaemonSettled {
  return { status, ...(pid === undefined ? {} : { pid }), changed };
}

async function autostartEnable(): Promise<AutostartChange> {
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
    throw new AiregError(`Could not turn autostart on: ${messageOf(error)}`, {
      code: ErrorCode.Unavailable,
      cause: error,
      hint: PROFILE_HINT,
    });
  }
  if (change === undefined) throw unsupported();
  await ensureDaemon(VERSION);
  return change;
}

const PROFILE_HINT =
  "Run `aireg daemon start` from your shell profile instead; it does nothing when the daemon is up.";

function unsupported(): AiregError {
  return new AiregError(`Autostart is not supported on ${process.platform}.`, {
    code: ErrorCode.Unavailable,
    hint: PROFILE_HINT,
  });
}

async function autostartDisable(): Promise<AutostartChange> {
  const change = await disableAutostart();
  if (change === undefined) throw unsupported();
  return change;
}

const MECHANISM: Record<AutostartState["mechanism"], string> = {
  launchd: "launchd agent",
  systemd: "systemd user service",
  "run-key": "Windows Run key",
};

function autostartReport(state: AutostartState | undefined, printer: Printer): void {
  if (state === undefined) {
    printer.info(`Off. Autostart is not supported on ${process.platform}.`);
    return;
  }
  if (!state.registered) {
    printer.info("Off.");
    printer.hint("Run `aireg daemon autostart on` to start the daemon at login.");
    return;
  }
  const style = printer.style;
  if (!state.loaded) {
    printer.warning(`The ${MECHANISM[state.mechanism]} is registered but not loaded.`);
    printer.hint(
      state.mechanism === "launchd"
        ? "Turn it on in System Settings > General > Login Items, or run `aireg daemon autostart on`."
        : "Run `aireg daemon autostart on` to load it again.",
    );
    return;
  }
  printer.info(`On   ${style.dim(`${MECHANISM[state.mechanism]}, ${state.location}`)}`);
  if (!state.current) {
    printer.warning("Autostart starts a different install of aireg than this one.");
    printer.hint("Run `aireg daemon autostart on` to point it at this one.");
  }
}

function switchedOn(change: AutostartChange, printer: Printer): void {
  if (!change.changed) {
    printer.info("Autostart is already on.");
    return;
  }
  printer.success(
    `Turned on autostart. The daemon now starts at login as a ${MECHANISM[change.state.mechanism]}.`,
  );
  printer.note("path", change.state.location);
}

function switchedOff(change: AutostartChange, printer: Printer): void {
  if (!change.changed) {
    printer.info("Autostart is already off.");
    return;
  }
  printer.success("Turned off autostart. Commands still start the daemon when they need it.");
}
