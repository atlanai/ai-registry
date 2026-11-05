import { relative } from "node:path";
import type { ListResult } from "#cli/commands/list/result.ts";
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
import type { Lock, LockArtifact, LockRegistry } from "#core/lock.ts";
import type { Manifest } from "#core/manifest/model.ts";
import { artifactPath, copyLeaf, type Roots, scopeName } from "#core/store/paths.ts";
import type { Targets } from "#core/target/contract.ts";
import { earlierId } from "#core/target/ids.ts";
import type { Printer } from "#core/term/printer.ts";
import { fields, table } from "#core/term/table.ts";
import { rowsNamed } from "#engine/installed-names.ts";
import type { CommonOptions } from "#engine/options.ts";
import { load } from "#engine/scope/load.ts";
import { defineCommand } from "./define.ts";

interface Options {
  common: CommonOptions;
  name: string | undefined;
}

interface Listing {
  roots: Roots;
  manifest: Manifest;
  lock: Lock;
  targetTable: Targets;
  rows: Installed[];
}

interface Detail {
  name: string;
  entry: LockArtifact;
  source: LockRegistry | undefined;
  copy: string;
  targetTable: Targets;
}

export const { run } = defineCommand({
  spec: LIST_COMMAND,
  parse(argv): Options {
    const { common, positionals } = parse(argv, LIST_COMMAND);
    return { common, name: positionals[0] };
  },
  async run({ common, name }, context): Promise<Listing | Detail> {
    const { roots, manifest, targetTable, lock } = await load(common, context.cwd, "user");
    // Naming one asks where it came from, which is the only question left once
    // you can already see it in the list.
    if (name !== undefined) return detail(lock, roots, targetTable, name);
    return { roots, manifest, lock, targetTable, rows: installed(lock, manifest, targetTable) };
  },
  data(found): ListResult {
    if ("entry" in found) return detailData(found);
    const { roots, targetTable, rows } = found;
    // aireg 0.1 printed these ids under `targets`.
    const artifacts = rows.map((row) => ({
      ...row,
      targets: [...row.targets].sort(),
      harnesses: row.targets.map((id) => earlierId(targetTable, id)).sort(),
    }));
    return { scope: roots.scope, artifacts };
  },
  text(found, printer) {
    if ("entry" in found) {
      printDetail(printer, found);
      return;
    }
    const { roots, manifest, lock, targetTable, rows } = found;
    if (rows.length === 0) {
      printer.info(`Nothing is installed in ${scopeName(roots.scope)}.`);
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

    heading(printer, rows.length, roots.scope);
    table(
      printer,
      [
        ...identity(printer, (row: Installed) => row),
        {
          header: "targets",
          value: (row: Installed) => {
            if (row.targets.length > 0) return printer.style.dim(tools(row));
            if (row.watched === undefined) return printer.style.dim("in no target");
            return printer.style.dim(`${toolName(targetTable, row.watched.target)} (watched)`);
          },
        },
      ],
      rows,
    );
  },
});

/** Offline, and under the name it is installed as however it was named. */
function detail(lock: Lock, roots: Roots, targetTable: Targets, input: string): Detail {
  const [name = input] = rowsNamed(input, lock);
  const entry = lock.artifacts[name] as LockArtifact;
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
  return { name, entry, source: lock.registries[entry.registry], copy, targetTable };
}

function detailData({ name, entry, source, copy, targetTable }: Detail): ListResult {
  const watched = watchedFrom(entry, targetTable);
  return {
    name,
    kind: entry.kind,
    registry: entry.registry,
    ...(source === undefined ? {} : { address: source.location }),
    ...(source === undefined ? {} : { adapter: source.adapter }),
    ...(source === undefined ? {} : { registryKey: source.key }),
    ...(source === undefined ? {} : { config: source.config }),
    ...(source?.revision === undefined ? {} : { revision: source.revision }),
    ...(entry.id === undefined ? {} : { id: entry.id }),
    upstreamName: entry.name,
    ...(entry.content === undefined ? {} : { content: entry.content }),
    ...(entry.version === undefined ? {} : { version: entry.version }),
    path: entry.path,
    copy,
    ...(watched === undefined ? {} : { watched }),
    links: entry.links.map(({ digest, ...link }) => ({
      ...link,
      ...(digest === undefined ? {} : { digest }),
      harness: earlierId(targetTable, link.target),
    })),
    ...(entry.neededBy === undefined ? {} : { neededBy: entry.neededBy }),
  };
}

function printDetail(printer: Printer, { name, entry, source, copy }: Detail): void {
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

  printer.info(`${printer.style.bold(name)}  ${printer.style.dim(entry.kind)}`);
  fields(printer, rows);
}
