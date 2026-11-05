import { relative, resolve } from "node:path";
import { REGISTRY_DOCUMENT } from "#adapter/filespec/names.ts";
import { plural, quoted, sanitizeText } from "#adapter/text.ts";
import { type Hidden, hiddenKind, printHidden, RESERVED } from "#cli/commands/builtins.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { workflowCommand } from "#cli/render/workflow-command.ts";
import { inGitHubActions } from "#core/env.ts";
import { ExitCode } from "#core/errors.ts";
import { requireRegistry } from "#core/filespec/init.ts";
import { kindsOf } from "#core/filespec/kind-manifests.ts";
import { validateRoot } from "#core/filespec/validate/validate.ts";
import { GLYPH } from "#core/term/theme.ts";

const MAX_PROBLEM = 2000;

/**
 * The merge gate: every problem with where it is and how to fix it, exit 1 on any.
 * In a pull request, released versions are compared with the branch it targets.
 */
export async function validate(
  context: CommandContext,
  input: string | undefined,
  base: string | undefined,
): Promise<void> {
  const root = requireRegistry(resolve(context.cwd, input ?? "."));
  const target = process.env.GITHUB_BASE_REF;
  const against = base ?? (target === undefined || target === "" ? undefined : `origin/${target}`);
  const result = await validateRoot(root, { base: against });
  const { problems } = result;
  if (problems.length > 0) context.exit = ExitCode.Error;
  const hidden = await hiddenKinds(root);
  printHidden(context.printer, hidden);

  if (context.printer.format === "json") {
    const warnings = hidden.map((entry) => entry.message);
    context.printer.json({ ok: problems.length === 0, data: { ...result, warnings } });
    return;
  }
  if (inGitHubActions()) {
    const prefix = relative(process.env.GITHUB_WORKSPACE ?? root, root);
    for (const problem of problems) {
      const file = prefix === "" ? problem.path : `${prefix}/${problem.path}`;
      const fix = problem.fix === undefined ? "" : ` Fix: ${problem.fix}`;
      const message = `${problem.message}.${fix}`;
      context.printer.info(workflowCommand("error", { file, title: "registry" }, message));
    }
    const file = prefix === "" ? REGISTRY_DOCUMENT : `${prefix}/${REGISTRY_DOCUMENT}`;
    for (const entry of hidden) {
      context.printer.info(workflowCommand("warning", { file, title: "registry" }, entry.message));
    }
  }
  if (problems.length === 0) {
    context.printer.success(
      `${result.name} is valid: ${plural(result.namespaces, "namespace")}, ${plural(result.artifacts, "artifact")} and ${plural(result.versions, "version")}.`,
    );
    context.printer.success("The index is up to date.");
    return;
  }
  printProblems(context.printer, problems);
  context.printer.info(`Found ${plural(problems.length, "problem")}.`);
}

/** Valid by the spec, but aireg's own commands hide them from aireg users. */
async function hiddenKinds(root: string): Promise<Hidden[]> {
  return Object.keys(await kindsOf(root))
    .filter((kind) => RESERVED.has(kind))
    .map(hiddenKind);
}

/**
 * Each file once, with every problem in it. A pull request names these paths,
 * and a newline in one would start a line of its own.
 */
function printProblems(
  printer: CommandContext["printer"],
  problems: readonly { path: string; message: string; fix?: string | undefined }[],
): void {
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
