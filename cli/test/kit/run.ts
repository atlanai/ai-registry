import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { homeEnv } from "./home.ts";

export const exec = promisify(execFile);
export const BIN = fileURLToPath(new URL("../../bin/aireg.mjs", import.meta.url));

// Below vitest's 60s test timeout, so a hung CLI fails with its own output rather than none.
const CLI_TIMEOUT_MS = 45_000;

/** What every `--json` command prints: data on success, a coded error otherwise. */
interface Envelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; hint?: string };
}

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  /** Stdout parsed as the `--json` envelope. */
  json<T = unknown>(): Envelope<T>;
  /** The error code a `--json` run failed with, undefined when it succeeded. */
  error(): string | undefined;
}

export interface RunOptions {
  cwd: string;
  /** Stands in for the user's home, so no real target or aireg state is read or written. */
  home: string;
  env?: NodeJS.ProcessEnv;
  /** Flags for node itself, ahead of the entry point. */
  node?: string[];
  /** Written to standard input, which is then closed. */
  input?: string;
}

function ran(code: number, stdout: string, stderr: string): Ran {
  const json = <T>(): Envelope<T> => {
    try {
      return JSON.parse(stdout) as Envelope<T>;
    } catch {
      throw new Error(`stdout is not JSON (exit ${code}):\n${stdout}\nstderr:\n${stderr}`);
    }
  };
  return {
    code,
    stdout,
    stderr,
    json,
    error: () => {
      const envelope = json();
      return envelope.ok ? undefined : envelope.error?.code;
    },
  };
}

/** Spawned, not imported: exit codes and stream routing are the contract. */
export async function runCli(args: readonly string[], options: RunOptions): Promise<Ran> {
  const { cwd, home, env = {}, node = [], input } = options;
  try {
    const running = exec(process.execPath, [...node, BIN, ...args], {
      cwd,
      env: { ...process.env, ...homeEnv(home), ...env },
      timeout: CLI_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (input !== undefined) running.child.stdin?.end(input);
    const { stdout, stderr } = await running;
    return ran(0, stdout, stderr);
  } catch (error) {
    const e = error as { code?: number; killed?: boolean; stdout?: string; stderr?: string };
    const stderr = e.stderr ?? "";
    const killed = e.killed === true ? `\naireg killed after ${CLI_TIMEOUT_MS} ms.\n` : "";
    return ran(e.code ?? 1, e.stdout ?? "", `${stderr}${killed}`);
  }
}
