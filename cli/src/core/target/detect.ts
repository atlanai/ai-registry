import { existsSync } from "node:fs";
import { join } from "node:path";
import { onPath } from "#adapter/paths.ts";
import { present } from "#core/env.ts";
import { expandUserPath } from "#core/fs/path.ts";
import { BUILTIN_TARGETS } from "#targets/index.ts";
import type { Target, Targets } from "./contract.ts";
import { names } from "./ids.ts";

/** Variables that name the coding agent running this process, in the order they are checked. */
export const CALLER_SIGNALS: readonly { agent: string; env: readonly string[] }[] =
  BUILTIN_TARGETS.flatMap((target) =>
    target.detect === "never" || target.detect?.caller === undefined
      ? []
      : [{ agent: target.id, env: target.detect.caller }],
  );

export type DetectionRule = "env" | "binary" | "project" | "user";

export interface Detection {
  target: Target;
  detected: boolean;
  /** Which rule fired, so `aireg targets` can explain itself. */
  by: DetectionRule | undefined;
}

export function detectAll(
  targetTable: Targets,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Detection[] {
  return names(targetTable).map((name) => detect(targetTable[name] as Target, cwd, env));
}

/** Prefer an explicit signal - env, then binary - over a directory that may be stale. */
function detect(target: Target, cwd: string, env: NodeJS.ProcessEnv = process.env): Detection {
  const signals = target.detect;
  if (signals === "never") return { target, detected: false, by: undefined };

  if (signals.env.some((name) => present(name, env))) return { target, detected: true, by: "env" };
  if (signals.binary.some((binary) => onPath(binary, env))) {
    return { target, detected: true, by: "binary" };
  }
  const project = [
    ...(signals.projectRoot === false ? [] : [target.projectRoot]),
    ...signals.paths.filter((path) => !path.startsWith("~/")),
  ];
  if (project.some((path) => existsSync(join(cwd, path)))) {
    return { target, detected: true, by: "project" };
  }
  const user = [target.userRoot, ...signals.paths.filter((path) => path.startsWith("~/"))];
  if (user.some((path) => existsSync(expandUserPath(path, env)))) {
    return { target, detected: true, by: "user" };
  }
  return { target, detected: false, by: undefined };
}
