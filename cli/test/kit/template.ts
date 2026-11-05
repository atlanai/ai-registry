import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeHome } from "./home.ts";
import { runCli } from "./run.ts";

/** Copies the project a template set up into `dir`, which may already exist. */
export type CopyProject = (dir: string) => Promise<void>;

/** Set up once per home for tests to copy; only for steps whose result lives in the project. */
export async function projectTemplate(
  dir: string,
  steps: readonly (readonly string[])[],
  dirs: readonly string[] = [],
): Promise<CopyProject> {
  const home = await makeHome(join(dir, "home"));
  const project = join(dir, "project");
  for (const each of ["", ...dirs]) await mkdir(join(project, each), { recursive: true });
  for (const args of steps) {
    const ran = await runCli(args, { cwd: project, home: home.dir, env: home.env });
    if (ran.code !== 0) {
      throw new Error(`\`aireg ${args.join(" ")}\` exited ${ran.code}:\n${ran.stderr}`);
    }
  }
  return (into) => cp(project, into, { recursive: true });
}
