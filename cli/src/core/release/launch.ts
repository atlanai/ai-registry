import { basename } from "node:path";
import { NAME } from "#core/product.ts";

export interface Launch {
  readonly command: string;
  readonly args: readonly string[];
}

const SCRIPT = /\.(?:m?[jt]s|cjs)$/i;

/** A standalone build is the executable; a script still needs the Node running it. */
export function launchArgv(
  entry: string,
  args: readonly string[] = [],
  execPath: string = process.execPath,
): Launch {
  if (!SCRIPT.test(entry)) return { command: entry, args };
  const flags = ["--disable-warning=ExperimentalWarning"];
  if (entry.endsWith(".ts")) flags.push("--experimental-strip-types");
  return { command: execPath, args: [...flags, entry, ...args] };
}

/**
 * A standalone build is its own interpreter, so `execPath` is the CLI; under Node
 * the CLI is `argv[1]`. A wrong answer silently turns the version floor off.
 */
export function runningEntry(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
): string | undefined {
  const name = basename(execPath).replace(/\.exe$/i, "");
  return name === NAME ? execPath : argv[1];
}
