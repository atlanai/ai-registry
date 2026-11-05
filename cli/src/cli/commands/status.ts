import { lstat } from "node:fs/promises";
import { relative } from "node:path";
import { isWithin } from "#adapter/paths.ts";
import { plural } from "#adapter/text.ts";
import { STATUS_COMMAND } from "#cli/commands/status/spec.ts";
import { noArguments, parse } from "#cli/options/parse.ts";
import { underHome } from "#cli/render/home.ts";
import { installed } from "#cli/render/installed.ts";
import { renderStatus } from "#cli/render/status.ts";
import { chosenFor, scopeTargets, toolName } from "#cli/render/tools.ts";
import { ExitCode } from "#core/errors.ts";
import { type Lock, readLock } from "#core/lock.ts";
import { namespaceOf, pluginLinkAt } from "#core/plan/projection.ts";
import { status, worstState } from "#core/plan/status.ts";
import { survey } from "#core/plan/survey.ts";
import { roots as makeRoots, type Roots } from "#core/store/paths.ts";
import { type Candidate, candidates, type DanglingLink, danglingLinks } from "#core/sync/adopt.ts";
import type { Targets } from "#core/target/contract.ts";
import { byEarlierIds, earlierId, names } from "#core/target/ids.ts";
import { trustFor } from "#core/target/placement.ts";
import { table } from "#core/term/table.ts";
import { load } from "#engine/scope/load.ts";
import type { CommandContext } from "./command.ts";

/**
 * Offline by design: whether upstream moved is `outdated`, a different question.
 * Like `git status` with untracked files, it also names what nothing manages.
 */
export async function run(context: CommandContext): Promise<void> {
  const { positionals, common } = parse(context.argv, STATUS_COMMAND);
  noArguments(positionals, "status");
  const { roots, manifest, targetTable, lock } = await load(common, context.cwd, "user");
  const statuses = status(lock, await survey(lock, roots), roots);
  const clashes = await shadowed(roots.scope, context.cwd, lock);
  // Everything a target loads, links and its own formats included; naming it adopts nothing.
  const found = await candidates(roots, targetTable, names(targetTable), lock, new Set(), {
    report: true,
  });
  const dangling = await danglingLinks(roots, targetTable, names(targetTable), lock);
  const loose = await Promise.all(found.local.map(unmanaged));
  const rows = installed(lock, manifest, targetTable);

  if (context.printer.format === "json") {
    const neededBy = new Map(rows.map((row) => [row.name, row.neededBy]));
    const approvals = needsApproval(lock, roots, targetTable);
    // `dangling` is as aireg 0.1 printed it, where `target` is the destination the link names.
    context.printer.json({
      ok: true,
      data: {
        scope: roots.scope,
        artifacts: statuses.map((item) => ({
          ...item,
          harnesses: byEarlierIds(targetTable, item.targets),
          neededBy: neededBy.get(item.name),
          needsApproval: approvals.get(item.name),
        })),
        shadowed: clashes,
        unmanaged: loose.map((item) => ({
          ...item,
          harnesses: item.targets.map((id) => earlierId(targetTable, id)),
        })),
        dangling: dangling.map(({ path, linksTo, target }) => ({
          path,
          target: linksTo,
          harness: earlierId(targetTable, target),
        })),
      },
    });
  } else {
    const scope = scopeTargets(manifest, targetTable);
    renderStatus(context.printer, statuses, rows, roots.scope, {
      targetTable,
      for: (name) => {
        const entry = lock.artifacts[name];
        return entry === undefined ? scope : chosenFor(manifest, scope, entry);
      },
    });
    for (const name of clashes) {
      context.printer.warning(
        `${name} is also installed in your user scope, and your target decides which one it loads.`,
      );
    }
    if (loose.length > 0) {
      context.printer.info();
      context.printer.info(context.printer.style.bold(`${loose.length} unmanaged`));
      table(
        context.printer,
        [
          { header: "artifact", value: (item: Unmanaged) => item.name },
          { header: "kind", value: (item: Unmanaged) => item.kind },
          {
            header: "target",
            value: (item: Unmanaged) =>
              item.targets.map((name) => toolName(targetTable, name)).join(", "),
          },
          { header: "path", value: (item: Unmanaged) => shown(roots, item.path) },
        ],
        loose,
      );
      context.printer.note("next", "aireg publish <path> --to <registry>/<namespace>");
    }
    printDangling(context, roots, targetTable, dangling);
  }

  if (worstState(statuses) !== "ok") context.exit = ExitCode.Changed;
}

/**
 * Installed at both scopes, so the target loads it twice or picks by its own order:
 * reported, never resolved. Matched by kind and upstream name, as the user scope names it.
 */
async function shadowed(scope: string, cwd: string, lock: Lock): Promise<string[]> {
  if (scope === "user") return [];
  const installed = Object.entries(lock.artifacts);
  if (installed.length === 0) return [];
  const other = new Set(
    Object.values((await readLock(makeRoots("user", cwd))).artifacts).map(
      (theirs) => `${theirs.kind}\0${theirs.name}`,
    ),
  );
  return installed
    .filter(([, row]) => other.has(`${row.kind}\0${row.name}`))
    .map(([name]) => name)
    .sort();
}

/** One row per artifact: each target once, and the real folder rather than a link to it. */
async function unmanaged(item: Candidate): Promise<Unmanaged> {
  const found = [{ from: item.from, target: item.target }, ...item.elsewhere];
  const links = await Promise.all(found.map(({ from }) => isLink(from)));
  return {
    name: item.name,
    kind: item.kind,
    targets: [...new Set(found.map(({ target }) => target))],
    path: (found[links.indexOf(false)] ?? item).from,
  };
}

interface Unmanaged {
  name: string;
  kind: string;
  targets: string[];
  path: string;
}

async function isLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The commands a person runs before each target loads an artifact; aireg never runs them. */
function needsApproval(
  lock: Lock,
  roots: Roots,
  targetTable: Targets,
): Map<string, { target: string; harness: string; run: string }[]> {
  const out = new Map<string, { target: string; harness: string; run: string }[]>();
  for (const [name, entry] of Object.entries(lock.artifacts)) {
    const namespace = namespaceOf({
      kind: entry.kind,
      name,
      group: entry.namespace,
      source: entry.registry,
    });
    const steps = entry.links.flatMap((link) => {
      const target = targetTable[link.target];
      if (target === undefined) return [];
      const plugin = pluginLinkAt(link, namespace, entry.registry, { roots, targetTable });
      const run = trustFor(target, plugin === undefined ? entry.kind : "plugin", roots.scope);
      if (run === undefined) return [];
      return [{ target: link.target, harness: earlierId(targetTable, link.target), run }];
    });
    if (steps.length > 0) out.set(name, steps);
  }
  return out;
}

/** Relative inside a project, so the path reads the same in every checkout. */
function shown(roots: { scope: string; base: string }, path: string): string {
  return roots.scope === "project" && isWithin(roots.base, path)
    ? relative(roots.base, path)
    : underHome(path);
}

/** A link of yours that points at nothing, so no target can load it. */
function printDangling(
  context: CommandContext,
  roots: { scope: string; base: string },
  targetTable: Targets,
  dangling: readonly DanglingLink[],
): void {
  if (dangling.length === 0) return;
  context.printer.info();
  context.printer.info(context.printer.style.bold(plural(dangling.length, "dangling link")));
  table(
    context.printer,
    [
      { header: "link", value: (item: DanglingLink) => shown(roots, item.path) },
      { header: "target", value: (item: DanglingLink) => toolName(targetTable, item.target) },
      { header: "missing target", value: (item: DanglingLink) => underHome(item.linksTo) },
    ],
    dangling,
  );
  context.printer.note("next", "rm <link>, which its target cannot load");
}
