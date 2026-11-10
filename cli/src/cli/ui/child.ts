import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { sanitizeText } from "#adapter/text.ts";
import type { Command } from "#core/console/actions.ts";
import { NAME } from "#core/product.ts";
import { launchArgv, runningEntry } from "#core/release/launch.ts";

/** Longer than an install of a large marketplace; past it, the child is stopped. */
const TIMEOUT_MS = 10 * 60_000;
/** Enough for a whole plan; a child printing past these is cut, not buffered. */
const MOST_LINES = 2_000;
const MOST_DATA = 8 * 1024 * 1024;

export interface Ran {
  code: number;
  /** What it printed for a person, escapes removed. */
  lines: string[];
  /** Under `--json`: the `{ ok, data }` or `{ ok, error }` it printed. */
  json:
    | { ok?: boolean; data?: unknown; error?: { code?: string; message?: string; hint?: string } }
    | undefined;
}

/**
 * Every write runs as a child of this same CLI, as the console's actions do, so the child
 * takes the lease and no other aireg on PATH is ever run.
 */
export function run(command: Command, root: string): Promise<Ran> {
  const json = command.argv.includes("--json");
  const launch = launchArgv(runningEntry() ?? NAME, command.argv);
  const child = spawn(launch.command, [...launch.args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  const lines: string[] = [];
  const say = (line: string) => {
    const shown = sanitizeText(line, 2_000);
    if (shown !== "" && lines.length < MOST_LINES) lines.push(shown);
  };
  let data = "";
  if (json) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (data.length < MOST_DATA) data += chunk;
    });
  } else {
    createInterface({ input: child.stdout }).on("line", say);
  }
  createInterface({ input: child.stderr }).on("line", say);
  const timer = setTimeout(() => {
    say(`Stopped after ${TIMEOUT_MS / 60_000} minutes.`);
    child.kill("SIGINT");
  }, TIMEOUT_MS);
  timer.unref();
  return new Promise((resolve) => {
    const settle = (code: number) => {
      clearTimeout(timer);
      resolve({ code, lines, json: json ? parsed(data) : undefined });
    };
    child.once("error", (error) => {
      say(`Could not run ${NAME}: ${error.message}`);
      settle(-1);
    });
    child.once("close", (code) => settle(code ?? -1));
  });
}

function parsed(text: string): Ran["json"] {
  try {
    const document: unknown = JSON.parse(text);
    return typeof document === "object" && document !== null
      ? (document as Ran["json"])
      : undefined;
  } catch {
    return undefined;
  }
}
