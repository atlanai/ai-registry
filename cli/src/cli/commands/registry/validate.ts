import { relative, resolve } from "node:path";
import { REGISTRY_DOCUMENT } from "#adapter/filespec/names.ts";
import { plural, quoted, sanitizeText } from "#adapter/text.ts";
import { type Hidden, hiddenKind, printHidden, RESERVED } from "#cli/commands/builtins.ts";
import { action } from "#cli/commands/define.ts";
import type { RegistryProblem, RegistryValidated } from "#cli/commands/registry/result.ts";
import { workflowCommand } from "#cli/render/workflow-command.ts";
import { inGitHubActions } from "#core/env.ts";
import { ExitCode } from "#core/errors.ts";
import { requireRegistry } from "#core/filespec/init.ts";
import { kindsOf } from "#core/filespec/kind-manifests.ts";
import { validateRoot } from "#core/filespec/validate/validate.ts";
import type { Printer } from "#core/term/printer.ts";
import { GLYPH } from "#core/term/theme.ts";
import type { Options } from "./options.ts";

const MAX_PROBLEM = 2000;

interface Checked {
  data: RegistryValidated;
  root: string;
}

/**
 * The merge gate: every problem with where it is and how to fix it, exit 1 on any.
 * In a pull request, released versions are compared with the branch it targets.
 */
export const validate = action({
  async run({ argument: input, flags }: Options, context): Promise<Checked> {
    const root = requireRegistry(resolve(context.cwd, input ?? "."));
    const target = process.env.GITHUB_BASE_REF;
    const against =
      flags.base ?? (target === undefined || target === "" ? undefined : `origin/${target}`);
    const { problems, ...counts } = await validateRoot(root, { base: against });
    if (problems.length > 0) context.exit = ExitCode.Error;
    const hidden = await hiddenKinds(root);
    printHidden(context.printer, hidden);
    return {
      data: {
        ...counts,
        problems: problems.map(({ fix, ...problem }) => ({
          ...problem,
          ...(fix === undefined ? {} : { fix }),
        })),
        warnings: hidden.map((entry) => entry.message),
      },
      root,
    };
  },
  data: (result) => result.data,
  ok: (result) => result.data.problems.length === 0,
  text({ data, root }, printer) {
    const { problems } = data;
    if (inGitHubActions()) {
      const prefix = relative(process.env.GITHUB_WORKSPACE ?? root, root);
      for (const problem of problems) {
        const file = prefix === "" ? problem.path : `${prefix}/${problem.path}`;
        const fix = problem.fix === undefined ? "" : ` Fix: ${problem.fix}`;
        const message = `${problem.message}.${fix}`;
        printer.info(workflowCommand("error", { file, title: "registry" }, message));
      }
      const file = prefix === "" ? REGISTRY_DOCUMENT : `${prefix}/${REGISTRY_DOCUMENT}`;
      for (const warning of data.warnings) {
        printer.info(workflowCommand("warning", { file, title: "registry" }, warning));
      }
    }
    if (problems.length === 0) {
      printer.success(
        `${data.name} is valid: ${plural(data.namespaces, "namespace")}, ${plural(data.artifacts, "artifact")} and ${plural(data.versions, "version")}.`,
      );
      printer.success("The index is up to date.");
      return;
    }
    printProblems(printer, problems);
    printer.info(`Found ${plural(problems.length, "problem")}.`);
  },
});

/** Valid by the spec, but aireg's own commands hide them from aireg users. */
async function hiddenKinds(root: string): Promise<Hidden[]> {
  return Object.keys(await kindsOf(root))
    .filter((kind) => RESERVED.has(kind))
    .map(hiddenKind);
}

/** A pull request names these paths, and a newline in one would start a line of its own. */
function printProblems(printer: Printer, problems: readonly RegistryProblem[]): void {
  const { style } = printer;
  const byPath = new Map<string, (typeof problems)[number][]>();
  for (const problem of problems) {
    byPath.set(problem.path, [...(byPath.get(problem.path) ?? []), problem]);
  }
  for (const [path, found] of byPath) {
    printer.info(`${style.red(GLYPH.failed)} ${pathText(path)}`);
    for (const problem of found) {
      printer.info(`    ${sanitizeText(problem.message, MAX_PROBLEM)}`);
      if (problem.fix !== undefined) {
        printer.info(style.dim(`    fix: ${sanitizeText(problem.fix, MAX_PROBLEM)}`));
      }
    }
  }
}

/** A path as it is, or quoted with its escapes shown when a terminal would act on it, as git does. */
function pathText(path: string): string {
  const shown = quoted(path);
  return shown.slice(1, -1) === path ? path : shown;
}
