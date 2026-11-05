import { ExitCode } from "#core/errors.ts";
import { LOG_FILE, NAME } from "#core/product.ts";
import { ensureHome } from "#core/store/paths.ts";
import { CLI_DEFAULT, DAEMON_DEFAULT, resolveLevel } from "./level.ts";
import { createLogger, nullLogger } from "./logger.ts";
import type { Level, Logger, Sink } from "./model.ts";
import {
  DAEMON_LOG_FILE,
  DAEMON_STDERR_FILE,
  fileSink,
  logPath,
  multiSink,
  stderrSink,
  trimCapture,
} from "./sink.ts";
import { throttleSink } from "./throttle.ts";

export interface LogBootstrap {
  logger: Logger;
  close(): void;
}

/**
 * The daemon writes to a file always. Nobody is watching its stderr - it is
 * spawned detached - so the file is the only account of a scheduled run.
 */
export function openDaemonLog(version: string, env: NodeJS.ProcessEnv = process.env): LogBootstrap {
  const home = ensureHome(env);
  // Here, not in whatever started the daemon, so a service manager's capture is trimmed too.
  trimCapture(logPath(home, DAEMON_STDERR_FILE));
  return build(
    resolveLevel(DAEMON_DEFAULT, { env }),
    () => throttleSink(fileSink({ path: logPath(home, DAEMON_LOG_FILE) })),
    { "service.name": `${NAME}-daemon`, "service.version": version, pid: process.pid },
  );
}

function build(
  level: Level | "off",
  sink: () => Sink,
  bindings: Record<string, unknown>,
): LogBootstrap {
  if (level === "off") return { logger: nullLogger(), close: () => {} };
  const destination = sink();
  return {
    logger: createLogger({ sink: destination, level, bindings }),
    close: () => destination.close?.(),
  };
}

/** Foreground runs stay silent until asked, and never write to stdout. */
export function openCliLog(
  version: string,
  flag?: string,
  env: NodeJS.ProcessEnv = process.env,
): LogBootstrap {
  return build(
    resolveLevel(CLI_DEFAULT, { flag, env }),
    () => multiSink(stderrSink(), fileSink({ path: logPath(ensureHome(env), LOG_FILE) })),
    { "service.name": `${NAME}-cli`, "service.version": version, pid: process.pid },
  );
}

/**
 * A crash in a detached daemon otherwise reaches a closed stdio. Handling these
 * suppresses Node's own exit, so the process must end itself.
 */
export function installCrashHandlers(logger: Logger, close: () => void): void {
  const report = (phase: string) => (error: unknown) => {
    logger.fatal("daemon terminated by an unhandled error", { phase, error });
    close();
    process.exit(ExitCode.Error);
  };
  process.once("uncaughtException", report("uncaughtException"));
  process.once("unhandledRejection", report("unhandledRejection"));
}
