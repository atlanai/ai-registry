import { lstat } from "node:fs/promises";
import { relative } from "node:path";
import { isWithin } from "#adapter/paths.ts";
import { plural } from "#adapter/text.ts";
import { noArguments, parse } from "#cli/options.ts";
import { underHome } from "#cli/render/home.ts";
import { installed } from "#cli/render/installed.ts";
import { renderStatus } from "#cli/render/status.ts";
import { chosenFor, scopeTargets, toolName } from "#cli/render/tools.ts";
import { ExitCode } from "#core/errors.ts";
import { type Harnesses, names, trustFor } from "#core/harness/index.ts";
import { type Lock, readLock } from "#core/lock.ts";
import { namespaceOf, pluginLinkAt } from "#core/plan/projection.ts";
import { status, worstState } from "#core/plan/status.ts";
import { survey } from "#core/plan/survey.ts";
import { roots as makeRoots, type Roots } from "#core/store/paths.ts";
import { type Candidate, candidates, type DanglingLink, danglingLinks } from "#core/sync/adopt.ts";
import { table } from "#core/term/table.ts";
import { load } from "#engine/pipeline.ts";
import { builtin, type CommandContext } from "./index.ts";

/**
 * Installed at both scopes, so the harness loads it twice or picks by its own order:
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

/** The commands a person runs before each harness loads an artifact; aireg never runs them. */
function needsApproval(
  lock: Lock,
  roots: Roots,
  harnesses: Harnesses,
): Map<string, { harness: string; run: string }[]> {
  const out = new Map<string, { harness: string; run: string }[]>();
  for (const [name, entry] of Object.entries(lock.artifacts)) {
    const namespace = namespaceOf({
      kind: entry.kind,
      name,
      group: entry.namespace,
      source: entry.registry,
    });
    const steps = entry.links.flatMap((link) => {
      const target = harnesses[link.harness];
      if (target === undefined) return [];
      const plugin = pluginLinkAt(link, namespace, entry.registry, { roots, harnesses });
      const run = trustFor(target, plugin === undefined ? entry.kind : "plugin", roots.scope);
      return run === undefined ? [] : [{ harness: link.harness, run }];
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

interface Unmanaged {
  name: string;
  kind: string;
  harnesses: string[];
  path: string;
}

async function isLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** One row per artifact: each harness once, and the real folder rather than a link to it. */
async function unmanaged(item: Candidate): Promise<Unmanaged> {
  const found = [{ from: item.from, target: item.target }, ...item.elsewhere];
  const links = await Promise.all(found.map(({ from }) => isLink(from)));
  return {
    name: item.name,
    kind: item.kind,
    harnesses: [...new Set(found.map(({ target }) => target))],
    path: (found[links.indexOf(false)] ?? item).from,
  };
}

/** A link of yours whose target is gone, which its harness cannot load. */
function printDangling(
  context: CommandContext,
  roots: { scope: string; base: string },
  harnesses: Harnesses,
  dangling: readonly DanglingLink[],
): void {
  if (dangling.length === 0) return;
  context.printer.info();
  context.printer.info(context.printer.style.bold(plural(dangling.length, "dangling link")));
  table(
    context.printer,
    [
      { header: "link", value: (item: DanglingLink) => shown(roots, item.path) },
      { header: "harness", value: (item: DanglingLink) => toolName(harnesses, item.harness) },
      { header: "missing target", value: (item: DanglingLink) => underHome(item.target) },
    ],
    dangling,
  );
  context.printer.note("next", "rm <link>, which its harness cannot load");
}

/**
 * Offline by design: whether upstream moved is `outdated`, a different question.
 * Like `git status` with untracked files, it also names what nothing manages.
 */
export async function run(context: CommandContext): Promise<void> {
  const { positionals, common } = parse(context.argv, builtin("status"));
  noArguments(positionals, "status");
  const { roots, manifest, harnesses, lock } = await load(common, context.cwd, "user");
  const statuses = status(lock, await survey(lock, roots), roots);
  const clashes = await shadowed(roots.scope, context.cwd, lock);
  // Everything a harness loads, links and its own formats included; naming it adopts nothing.
  const found = await candidates(roots, harnesses, names(harnesses), lock, new Set(), {
    report: true,
  });
  const dangling = await danglingLinks(roots, harnesses, names(harnesses), lock);
  const loose = await Promise.all(found.local.map(unmanaged));
  const rows = installed(lock, manifest);

  if (context.printer.format === "json") {
    const neededBy = new Map(rows.map((row) => [row.name, row.neededBy]));
    const approvals = needsApproval(lock, roots, harnesses);
    context.printer.json({
      ok: true,
      data: {
        scope: roots.scope,
        artifacts: statuses.map((item) => ({
          ...item,
          neededBy: neededBy.get(item.name),
          needsApproval: approvals.get(item.name),
        })),
        shadowed: clashes,
        unmanaged: loose,
        dangling,
      },
    });
  } else {
    const scope = scopeTargets(manifest, harnesses);
    renderStatus(context.printer, statuses, rows, roots.scope, {
      harnesses,
      for: (name) => {
        const entry = lock.artifacts[name];
        return entry === undefined ? scope : chosenFor(manifest, scope, entry);
      },
    });
    for (const name of clashes) {
      context.printer.warning(
        `${name} is also installed in your user scope, and your harness decides which one it loads.`,
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
            header: "harness",
            value: (item: Unmanaged) =>
              item.harnesses.map((name) => toolName(harnesses, name)).join(", "),
          },
          { header: "path", value: (item: Unmanaged) => shown(roots, item.path) },
        ],
        loose,
      );
      context.printer.note("next", "aireg publish <path> --to <registry>/<namespace>");
    }
    printDangling(context, roots, harnesses, dangling);
  }

  if (worstState(statuses) !== "ok") context.exit = ExitCode.Changed;
}
