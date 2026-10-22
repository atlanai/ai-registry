/*
 * Every write the console performs is an `aireg` command, run as a child: the
 * CLI owns the lease, and two writers in one process would take it twice.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { spawnDetached } from "#core/process.ts";
import { NAME } from "#core/product.ts";
import { launchArgv, runningEntry } from "#core/release/launch.ts";
import type { Scope } from "#core/store/paths.ts";

export interface Command {
  /** Shown in the confirm screen, verbatim, so nothing happens unannounced. */
  display: string;
  argv: string[];
}

/** Shown as a POSIX shell would need it typed, so the confirm screen can be pasted. */
function shown(argv: string[]): Command {
  const words = argv.map((arg) =>
    /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`,
  );
  return { display: `${NAME} ${words.join(" ")}`, argv };
}

/** The tree the console is reading, so a child command acts on the same one. */
function scoped(scope: Scope): string[] {
  return scope === "user" ? ["-g"] : [];
}

/**
 * Names read from a lockfile or a config, after `--` and every option: a name
 * such as `-g` or `--yes` then stays a name and cannot change what the child does.
 */
function data(values: readonly string[]): string[] {
  return values.length === 0 ? [] : ["--", ...values];
}

export function pullLatest(alias: string | undefined, scope: Scope): Command {
  const argv = [
    "sync",
    ...scoped(scope),
    "--pull",
    "on",
    // A pull is a pull: nothing here may send or remove anything.
    "--publish",
    "off",
    "--delete",
    "off",
    "--yes",
    ...data(alias === undefined ? [] : [alias]),
  ];
  return shown(argv);
}

/** Installed work goes back where it came from; only authored work needs a `<alias>/<namespace>`. */
export function publish(names: readonly string[], to: string | undefined, scope: Scope): Command {
  const argv = ["publish", ...scoped(scope)];
  if (to !== undefined) argv.push("--to", to);
  argv.push("--yes", ...data(names));
  return shown(argv);
}

export function runJob(id: string): Command {
  const argv = ["job", "start", ...data([id])];
  return shown(argv);
}

export function setJobEnabled(id: string, enabled: boolean): Command {
  const argv = ["job", enabled ? "enable" : "disable", ...data([id])];
  return shown(argv);
}

export function retryRun(id: string): Command {
  const argv = ["job", "retry", ...data([id])];
  return shown(argv);
}

export interface Running {
  /** Resolves with the exit code once the child has finished. */
  done: Promise<number>;
  cancel(): void;
}

/** `root` is the folder the console shows, so the child acts on that tree, not the caller's. */
export function start(command: Command, root: string, onLine: (line: string) => void): Running {
  // The same launcher self-update uses: a standalone build is its own interpreter.
  const launch = launchArgv(runningEntry() ?? NAME, command.argv);
  const child = spawn(launch.command, [...launch.args], {
    cwd: root,
    // The console owns the terminal, so the child gets pipes and never stdin.
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null) continue;
    createInterface({ input: stream }).on("line", (line) => {
      const text = line.trimEnd();
      if (text !== "") onLine(text);
    });
  }
  const done = new Promise<number>((resolve) => {
    child.once("error", (error) => {
      onLine(`Could not run ${launch.command}: ${error.message}`);
      resolve(-1);
    });
    child.once("close", (code) => resolve(code ?? -1));
  });
  return { done, cancel: () => child.kill("SIGINT") };
}

/**
 * The command that opens `link` in the default browser, or undefined for anything but a
 * web page: `open` would also launch a file or an app, and `cmd /c start` runs what follows a `&`.
 */
export function browserCommand(
  link: string,
  platform: NodeJS.Platform = process.platform,
): [string, string[]] | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  // url.dll's handler takes the URL as one argument and runs no shell.
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url.href]];
  return [platform === "darwin" ? "open" : "xdg-open", [url.href]];
}

/** Opens a link in the default browser, best effort: a failure is not an error. */
export function open(link: string): void {
  const command = browserCommand(link);
  if (command === undefined) return;
  try {
    spawnDetached(...command);
  } catch {
    // No browser is a fine outcome; the URL is on screen either way.
  }
}
