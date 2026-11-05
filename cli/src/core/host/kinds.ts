import { messageOf } from "#adapter/errors.ts";
import { isRecord } from "#adapter/fields.ts";
import { isDeviceName, isKindSegment } from "#adapter/filespec/names.ts";
import { isBuiltinKind, KINDS } from "#adapter/kinds.ts";
import { canonicalize } from "#adapter/spec/canonical.ts";
import { list, quoted, sanitizeText } from "#adapter/text.ts";
import { loadAdapters } from "#core/adapter/load.ts";
import { type DeclaredKind, declareKinds, type KindSpec, kindSpec } from "#core/kinds.ts";
import type { Targets } from "#core/target/contract.ts";
import { resolveTargets } from "#core/target/table.ts";
import { fixedPrefix } from "#core/target/template.ts";
import { BUILTIN_TARGETS } from "#targets/index.ts";
import { extensionOf } from "./extend.ts";
import { mappingsOf } from "./kind-mappings.ts";

/** What one adapter's `extend.kinds` holds, unchecked. */
export interface Declaring {
  adapter: string;
  kinds: unknown;
}

/** Loads every adapter and declares the kinds they add; the warnings say what was refused. */
export async function loadDeclaredKinds(): Promise<string[]> {
  const { loaded, broken } = await loadAdapters();
  const failed = broken.map(
    ({ id, error }) =>
      `The adapter ${quoted(id)} did not load, so aireg does not know the kinds it declares: ${messageOf(error)}`,
  );
  const declaring = loaded.flatMap((adapter) => {
    const kinds = extensionOf(adapter)?.kinds;
    return kinds === undefined ? [] : [{ adapter: adapter.id, kinds }];
  });
  // Declared before targets resolve, so no earlier declaration's mappings decide this one.
  declareKinds([]);
  if (declaring.length === 0) return failed;
  const { kinds, warnings } = acceptKinds(declaring, resolveTargets(process.env));
  declareKinds(kinds);
  return [...failed, ...warnings];
}

interface Offer {
  adapter: string;
  kind: DeclaredKind;
  /** The definition in canonical JSON, so two adapters agreeing on one compare equal. */
  key: string;
}

/**
 * A bad declaration costs only its own adapter's kinds; two adapters giving one name different
 * definitions, or two names one folder, cost that kind for both.
 */
export function acceptKinds(
  declaring: readonly Declaring[],
  targetTable: Targets,
): { kinds: DeclaredKind[]; warnings: string[] } {
  const warnings: string[] = [];
  const offers: Offer[] = [];
  for (const { adapter, kinds } of declaring) {
    const read = readKinds(kinds, targetTable);
    if (typeof read === "string") {
      warnings.push(
        `The adapter ${quoted(adapter)} declares kinds aireg cannot use, so it adds none: ${read}`,
      );
      continue;
    }
    for (const kind of read) offers.push({ adapter, kind, key: canonicalize(kind) });
  }
  const refused = new Set<string>();
  for (const offer of offers) {
    const rival = offers.find(
      (other) =>
        other.adapter !== offer.adapter &&
        ((other.kind.name === offer.kind.name && other.key !== offer.key) ||
          (other.kind.name !== offer.kind.name && other.kind.spec.dir === offer.kind.spec.dir)),
    );
    if (rival === undefined || refused.has(offer.kind.name)) continue;
    refused.add(offer.kind.name);
    refused.add(rival.kind.name);
    const what =
      rival.kind.name === offer.kind.name
        ? `define the kind ${quoted(offer.kind.name)} differently`
        : `both keep their kinds ${quoted(offer.kind.name)} and ${quoted(rival.kind.name)} in the folder ${quoted(offer.kind.spec.dir)}`;
    warnings.push(
      `The adapters ${list([quoted(offer.adapter), quoted(rival.adapter)])} ${what}, so neither is loaded.`,
    );
  }
  const accepted = new Map<string, DeclaredKind>();
  for (const { kind } of offers) {
    if (!refused.has(kind.name) && !accepted.has(kind.name)) accepted.set(kind.name, kind);
  }
  return { kinds: [...accepted.values()], warnings };
}

/** Every kind the adapter declares, or the first problem as a sentence. */
function readKinds(raw: unknown, targetTable: Targets): DeclaredKind[] | string {
  if (!Array.isArray(raw)) return "`kinds` is not a list.";
  const kinds: DeclaredKind[] = [];
  for (const [at, each] of raw.entries()) {
    const read = readKind(each, targetTable);
    const name = isRecord(each) && typeof each.name === "string" ? quoted(each.name) : `kind ${at}`;
    if (typeof read === "string") return `${name} ${read}.`;
    if (kinds.some((kind) => kind.name === read.name)) return `${name} is declared twice.`;
    if (kinds.some((kind) => kind.spec.dir === read.spec.dir)) {
      return `${name} keeps its artifacts in ${quoted(read.spec.dir)}, as another of its kinds does.`;
    }
    kinds.push(read);
  }
  return kinds;
}

/** One folder name: no separator, no dot segment, and nothing Windows opens as a device. */
const DIR = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EXTENSION = /^\.[A-Za-z0-9]{1,16}$/;
const ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function readKind(raw: unknown, targetTable: Targets): DeclaredKind | string {
  if (!isRecord(raw)) return "is not a mapping";
  const { name, dir, shape, extensions, entry, description, targets } = raw;
  if (typeof name !== "string" || !isKindSegment(name)) return "is not a kind name";
  // Built-ins always win, so a kind that shadows one is refused rather than ignored.
  if (isBuiltinKind(name)) return "is a built-in kind";
  if (typeof dir !== "string" || !DIR.test(dir) || isDeviceName(dir)) {
    return "has a `dir` that is not one lowercase folder name";
  }
  const builtin = KINDS.find((kind) => kindSpec(kind)?.dir === dir);
  if (builtin !== undefined)
    return `keeps its artifacts in ${quoted(dir)}, the built-in ${builtin}s' folder`;
  // A namespace's folder is the plugin a target loads, so a kind kept in one it reads would load.
  if (pluginFolders().has(dir))
    return `keeps its artifacts in ${quoted(dir)}, a folder plugins load`;
  if (shape !== "directory" && shape !== "file")
    return "has a `shape` that is neither directory nor file";
  const spec = specOf(shape, extensions, entry);
  if (typeof spec === "string") return spec;
  if (description !== undefined && typeof description !== "string") {
    return "has a `description` that is not text";
  }
  const placed = mappingsOf(name, spec, targets, targetTable);
  if (typeof placed === "string") return placed;
  return {
    name,
    spec: { ...spec, dir },
    description:
      description === undefined || description.trim() === ""
        ? undefined
        : sanitizeText(description),
    targets: placed,
  };
}

/** Folders a plugin loader reads inside a plugin, and those the built-in targets place plugins in. */
const PLUGIN_FOLDERS = [
  "agents",
  "bin",
  "commands",
  "hooks",
  "lsp",
  "mcp",
  "monitors",
  "output-styles",
  "plugins",
  "prompts",
  "rules",
  "skills",
  "themes",
];

function pluginFolders(): Set<string> {
  const folders = new Set(PLUGIN_FOLDERS);
  for (const target of BUILTIN_TARGETS) {
    const plugin = target.kinds.plugin;
    if (plugin?.subdir === undefined) continue;
    for (const segment of fixedPrefix(plugin.subdir)) folders.add(segment);
    for (const entry of plugin.manifest ?? []) folders.add(entry.path.split("/")[0] ?? "");
  }
  return folders;
}

function specOf(
  shape: KindSpec["shape"],
  extensions: unknown,
  entry: unknown,
): Omit<KindSpec, "dir"> | string {
  if (shape === "file") {
    if (entry !== undefined) return "sets `entry`, which only a directory kind has";
    const listed = Array.isArray(extensions) ? extensions : [];
    if (
      listed.length === 0 ||
      !listed.every((each) => typeof each === "string" && EXTENSION.test(each))
    ) {
      return 'is one file, so it needs `extensions` such as [".md"]';
    }
    return { shape, extensions: [...new Set(listed as string[])] };
  }
  if (extensions !== undefined && !(Array.isArray(extensions) && extensions.length === 0)) {
    return "sets `extensions`, which only a file kind has";
  }
  if (entry === undefined) return { shape, extensions: [] };
  if (typeof entry !== "string" || !ENTRY.test(entry) || isDeviceName(entry)) {
    return "has an `entry` that is not a file name";
  }
  return { shape, extensions: [], entry };
}
