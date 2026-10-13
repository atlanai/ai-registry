import { relative } from "node:path";
import { rowsNamed } from "#cli/names.ts";
import { parse } from "#cli/options.ts";
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
import { fields, table } from "#core/term/table.ts";
import { load } from "#engine/pipeline.ts";
import { builtin, type CommandContext } from "./index.ts";

export async function run(context: CommandContext): Promise<void> {
  const { common, positionals } = parse(context.argv, builtin("list"));
  const { roots, manifest, harnesses, lock } = await load(common, context.cwd, "user");

  // Naming one asks where it came from, which is the only question left once
  // you can already see it in the list.
  const wanted = positionals[0];
  if (wanted !== undefined) return detail(context, lock, roots, wanted);

  const rows = installed(lock, manifest);

  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { scope: roots.scope, artifacts: rows } });
    return;
  }

  if (rows.length === 0) {
    context.printer.info(`Nothing is installed in ${scopeName(roots.scope)}.`);
    return;
  }

  // Named as they were chosen, not by the folders that serve them: JSON keeps the folders.
  const scope = scopeTargets(manifest, harnesses);
  const tools = (row: Installed): string => {
    const entry = lock.artifacts[row.name];
    if (entry === undefined) return row.targets.join(", ");
    return loadedBy(harnesses, chosenFor(manifest, scope, entry), entry.kind, row.targets)
      .map((name) => toolName(harnesses, name))
      .join(", ");
  };

  heading(context.printer, rows.length, roots.scope);
  table(
    context.printer,
    [
      ...identity(context.printer, (row: Installed) => row),
      {
        header: "harnesses",
        value: (row: Installed) =>
          context.printer.style.dim(
            row.targets.length > 0
              ? tools(row)
              : row.watched !== undefined
                ? `${toolName(harnesses, row.watched.harness)} (watched)`
                : "in no harness",
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
        watched: watchedFrom(entry),
        links: entry.links,
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
    rows.push(["watched", `${entry.origin.path} (${entry.origin.harness})`]);
  add("needed by", entry.neededBy?.join(", "));
  for (const link of entry.links) rows.push([link.harness, `${link.path} (${link.mode})`]);

  context.printer.info(
    `${context.printer.style.bold(name)}  ${context.printer.style.dim(entry.kind)}`,
  );
  fields(context.printer, rows);
}
