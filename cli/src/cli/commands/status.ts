import { relative } from "node:path";
import { isWithin } from "#adapter/paths.ts";
import { noArguments, parse } from "#cli/options.ts";
import { underHome } from "#cli/render/home.ts";
import { installed } from "#cli/render/installed.ts";
import { renderStatus } from "#cli/render/status.ts";
import { chosenFor, scopeTargets, toolName } from "#cli/render/tools.ts";
import { ExitCode } from "#core/errors.ts";
import { names } from "#core/harness/index.ts";
import { type Lock, readLock } from "#core/lock.ts";
import { status, worstState } from "#core/plan/status.ts";
import { survey } from "#core/plan/survey.ts";
import { roots as makeRoots } from "#core/store/paths.ts";
import { type Candidate, candidates } from "#core/sync/adopt.ts";
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

function unmanaged(item: Candidate): Unmanaged {
  return {
    name: item.name,
    kind: item.kind,
    harnesses: [item.target, ...item.elsewhere.map(({ target }) => target)],
    path: item.from,
  };
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
  const found = await candidates(roots, harnesses, names(harnesses), lock);
  const loose = found.local.map(unmanaged);
  const rows = installed(lock, manifest);

  if (context.printer.format === "json") {
    const neededBy = new Map(rows.map((row) => [row.name, row.neededBy]));
    context.printer.json({
      ok: true,
      data: {
        scope: roots.scope,
        artifacts: statuses.map((item) => ({ ...item, neededBy: neededBy.get(item.name) })),
        shadowed: clashes,
        unmanaged: loose,
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
  }

  if (worstState(statuses) !== "ok") context.exit = ExitCode.Changed;
}
