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

export function pullLatest(alias: string | undefined, scope: Scope): Command {
  // A pull is a pull: nothing here may send or remove anything.
  const argv = [
    "sync",
    ...scoped(scope),
    "--pull",
    "on",
    "--publish",
    "off",
    "--delete",
    "off",
    "--yes",
    ...data(alias === undefined ? [] : [alias]),
  ];
  return shown(argv);
}

/** So a child command acts on the same tree the console reads. */
function scoped(scope: Scope): string[] {
  return scope === "user" ? ["-g"] : [];
}

/** After `--` and every option, so a name such as `-g` or `--yes` cannot steer the child. */
function data(values: readonly string[]): string[] {
  return values.length === 0 ? [] : ["--", ...values];
}

/** Shown as a POSIX shell would need it typed, so the confirm screen can be pasted. */
function shown(argv: string[]): Command {
  const words = argv.map((arg) =>
    /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`,
  );
  return { display: `${NAME} ${words.join(" ")}`, argv };
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
  done: Promise<number>;
  cancel(): void;
}

/** Every write runs as a child CLI, which owns the lease; a writer here would take it twice. */
export function start(command: Command, root: string, onLine: (line: string) => void): Running {
  // The same launcher self-update uses: a standalone build is its own interpreter.
  const launch = launchArgv(runningEntry() ?? NAME, command.argv);
  // The console owns the terminal, so the child gets pipes and never stdin.
  const child = spawn(launch.command, [...launch.args], {
    cwd: root,
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
 * Undefined for anything but a web page: `open` would also launch a file or an app, and
 * `cmd /c start` runs what follows a `&`.
 */
export function browserCommand(
  link: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): [string, string[]] | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  // $BROWSER, as xdg-open and gh read it: the first program of the list, run without a shell.
  const chosen = env.BROWSER?.split(platform === "win32" ? ";" : ":")[0]?.trim();
  if (chosen !== undefined && chosen !== "") return [chosen, [url.href]];
  // url.dll's handler takes the URL as one argument and runs no shell.
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url.href]];
  return [platform === "darwin" ? "open" : "xdg-open", [url.href]];
}

/** Best effort: a failure is not an error. */
export function open(link: string): void {
  const command = browserCommand(link);
  if (command === undefined) return;
  try {
    spawnDetached(...command);
  } catch {
    // No browser is a fine outcome; the URL is on screen either way.
  }
}
