import { relative } from "node:path";
import { LIST_COMMAND } from "#cli/commands/list/spec.ts";
import { parse } from "#cli/options/parse.ts";
import {
  heading,
  type Installed,
  identity,
  installed,
  watchedFrom,
} from "#cli/render/installed.ts";
import { chosenFor, loadedBy, scopeTargets, toolName } from "#cli/render/tools.ts";
import type { LockArtifact, readLock } from "#core/lock.ts";
import { artifactPath, copyLeaf, scopeName } from "#core/store/paths.ts";
import type { Targets } from "#core/target/contract.ts";
import { earlierId } from "#core/target/ids.ts";
import { fields, table } from "#core/term/table.ts";
import { rowsNamed } from "#engine/installed-names.ts";
import { load } from "#engine/scope/load.ts";
import type { CommandContext } from "./command.ts";

export async function run(context: CommandContext): Promise<void> {
  const { common, positionals } = parse(context.argv, LIST_COMMAND);
  const { roots, manifest, targetTable, lock } = await load(common, context.cwd, "user");

  // Naming one asks where it came from, which is the only question left once
  // you can already see it in the list.
  const wanted = positionals[0];
  if (wanted !== undefined) return detail(context, lock, roots, targetTable, wanted);

  const rows = installed(lock, manifest, targetTable);

  if (context.printer.format === "json") {
    // aireg 0.1 printed these ids under `targets`.
    const artifacts = rows.map((row) => ({
      ...row,
      targets: [...row.targets].sort(),
      harnesses: row.targets.map((id) => earlierId(targetTable, id)).sort(),
    }));
    context.printer.json({ ok: true, data: { scope: roots.scope, artifacts } });
    return;
  }

  if (rows.length === 0) {
    context.printer.info(`Nothing is installed in ${scopeName(roots.scope)}.`);
    return;
  }

  // Named as they were chosen, not by the folders that serve them: JSON keeps the folders.
  const scope = scopeTargets(manifest, targetTable);
  const tools = (row: Installed): string => {
    const entry = lock.artifacts[row.name];
    if (entry === undefined) return row.targets.join(", ");
    return loadedBy(targetTable, chosenFor(manifest, scope, entry), entry.kind, row.targets)
      .map((name) => toolName(targetTable, name))
      .join(", ");
  };

  heading(context.printer, rows.length, roots.scope);
  table(
    context.printer,
    [
      ...identity(context.printer, (row: Installed) => row),
      {
        header: "targets",
        value: (row: Installed) =>
          context.printer.style.dim(
            row.targets.length > 0
              ? tools(row)
              : row.watched !== undefined
                ? `${toolName(targetTable, row.watched.target)} (watched)`
                : "in no target",
          ),
      },
    ],
    rows,
  );
}

/** Where this came from, in one screen, without a network call. */
async function detail(
  context: CommandContext,
  lock: Awaited<ReturnType<typeof readLock>>,
  roots: Awaited<ReturnType<typeof load>>["roots"],
  targetTable: Targets,
  name: string,
): Promise<void> {
  const [key] = rowsNamed(name, lock);
  const entry = lock.artifacts[key as string] as LockArtifact;

  const source = lock.registries[entry.registry];
  const copy = relative(
    roots.base,
    artifactPath(
      roots,
      entry.registry,
      entry.namespace,
      entry.kind,
      copyLeaf(name, entry.name),
      entry.path,
    ),
  );

  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: {
        name,
        kind: entry.kind,
        registry: entry.registry,
        address: source?.location,
        adapter: source?.adapter,
        registryKey: source?.key,
        config: source?.config,
        revision: source?.revision,
        id: entry.id,
        upstreamName: entry.name,
        content: entry.content,
        version: entry.version,
        path: entry.path,
        copy,
        watched: watchedFrom(entry, targetTable),
        links: entry.links.map((link) => ({
          ...link,
          harness: earlierId(targetTable, link.target),
        })),
        neededBy: entry.neededBy,
      },
    });
    return;
  }

  const rows: [string, string][] = [
    ["registry", entry.registry],
    ["address", source?.location ?? "unknown"],
  ];
  const add = (label: string, value: string | undefined): void => {
    if (value !== undefined) rows.push([label, value]);
  };

  add("adapter", source?.adapter);
  add("registry key", source?.key);
  for (const [key, value] of Object.entries(source?.config ?? {})) {
    rows.push([`config.${key}`, value]);
  }
  add("snapshot", source?.revision);
  add("id", entry.id);
  add("upstream name", entry.name === name ? undefined : entry.name);
  add("content", entry.content);
  add("version", entry.version);
  rows.push(["path", entry.path === "" ? "<root>" : entry.path]);
  // The one path worth knowing: every link below leads here, and this is what
  // an edit changes.
  rows.push(["copy", copy]);
  if (entry.origin !== undefined)
    rows.push(["watched", `${entry.origin.path} (${entry.origin.target})`]);
  add("needed by", entry.neededBy?.join(", "));
  for (const link of entry.links) rows.push([link.target, `${link.path} (${link.mode})`]);

  context.printer.info(
    `${context.printer.style.bold(name)}  ${context.printer.style.dim(entry.kind)}`,
  );
  fields(context.printer, rows);
}
