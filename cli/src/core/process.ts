import {
  type ChildProcess,
  type ExecFileException,
  execFile,
  type StdioOptions,
  spawn,
} from "node:child_process";
import { constants } from "node:os";
import { isAbsolute } from "node:path";
import { programPath, withAbsolutePath } from "#adapter/paths.ts";
import { launchArgv } from "#core/release/launch.ts";

/** True while `pid` runs; EPERM means it runs as another user, which still counts. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A process that outlives this one: its own group, and nothing keeps this one waiting on it. */
export function spawnDetached(
  command: string,
  args: readonly string[],
  options: { stdio?: StdioOptions; env?: NodeJS.ProcessEnv } = {},
): ChildProcess {
  const program = programPath(command, options.env ?? process.env);
  if (program === undefined) throw new Error(`${command} was not found.`);
  const child = spawn(program, [...args], {
    detached: true,
    stdio: options.stdio ?? "ignore",
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  child.unref();
  return child;
}

export interface ExecResult {
  code: number;
  stdout: string;
  /** Ends with why, when the command did not exit on its own. */
  stderr: string;
}

export interface ExecOptions {
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Aborting kills the command and rejects, rather than reporting an exit. */
  signal?: AbortSignal | undefined;
  /** Past this much on stdout or stderr the command is stopped. */
  maxOutputBytes?: number;
}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Codes as a shell gives them: 127 missing, 126 cannot run, 128 plus a signal, 124 a timeout. */
function failed(
  command: string,
  error: ExecFileException,
  options: ExecOptions,
): { code: number; why?: string } {
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    const limit = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    return {
      code: 128 + constants.signals.SIGTERM,
      why: `${command} wrote more than ${limit} bytes, so it was stopped.`,
    };
  }
  if (error.code === "ENOENT") return { code: 127, why: `${command} was not found.` };
  if (typeof error.code === "string") {
    return { code: 126, why: `${command} could not run: ${error.code}.` };
  }
  if (error.signal !== null && error.signal !== undefined) {
    return error.killed === true
      ? { code: 124, why: `${command} did not finish within ${options.timeoutMs} ms.` }
      : {
          code: 128 + constants.signals[error.signal],
          why: `${command} was stopped by ${error.signal}.`,
        };
  }
  return { code: typeof error.code === "number" ? error.code : 1 };
}

function launchable(
  command: string,
  given: NodeJS.ProcessEnv,
  cwd: string | undefined,
): { program: string; env: NodeJS.ProcessEnv } | string {
  let env: NodeJS.ProcessEnv;
  try {
    env = withAbsolutePath(given);
  } catch (error) {
    // Found without PATH, so it runs; its own children get no PATH to search.
    env = Object.fromEntries(Object.entries(given).filter(([key]) => key.toUpperCase() !== "PATH"));
    const program = programPath(command, env, cwd);
    return program !== undefined && isAbsolute(program)
      ? { program, env }
      : (error as Error).message;
  }
  const program = programPath(command, env, cwd);
  return program === undefined ? `${command} was not found.` : { program, env };
}

/**
 * Runs a command to completion without a shell. A non-zero exit, a timeout, a signal,
 * output past the limit or a missing binary is a `code` to read, never a throw. A command
 * found only through PATH is missing too when no folder on PATH is absolute.
 */
export function exec(
  command: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const ready = launchable(command, options.env ?? process.env, options.cwd);
    if (typeof ready === "string") {
      resolve({ code: 127, stdout: "", stderr: ready });
      return;
    }
    const { program, env } = ready;
    execFile(
      program,
      [...args],
      {
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
        windowsHide: true,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, stdout, stderr) => {
        if (error?.name === "AbortError") {
          reject(error);
          return;
        }
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const { code, why } = failed(command, error, options);
        const said =
          why === undefined || stderr === "" || stderr.endsWith("\n") ? stderr : `${stderr}\n`;
        resolve({ code, stdout, stderr: `${said}${why ?? ""}` });
      },
    );
  });
}

/** Runs another aireg in this terminal and returns its exit status, for when it takes over. */
export function handOff(
  bin: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const launch = launchArgv(bin, argv);
    const child = spawn(launch.command, [...launch.args], { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
