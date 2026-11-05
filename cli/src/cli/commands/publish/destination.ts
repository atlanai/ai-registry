import { relative } from "node:path";
import { isLocalPath } from "#adapter/paths.ts";
import { list, plural } from "#adapter/text.ts";
import { chooseRegistry } from "#cli/prompt/choose-registry.ts";
import { type Interaction, interactive } from "#cli/prompt/interaction.ts";
import { canceled } from "#cli/prompt/model.ts";
import { select } from "#cli/prompt/select.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonical } from "#core/fs/realpath.ts";
import { unknownRegistry } from "#core/manifest/errors.ts";
import type { Manifest, RegistrySource } from "#core/manifest/model.ts";
import { gitIn } from "#core/process.ts";
import { knownIn } from "#engine/address/registries.ts";
import { chooseTarget, forTarget, namesTarget, type Skipped } from "#engine/publish/exports.ts";
import { type Destination, folderTo, parseTo, writableRegistries } from "#engine/publish/target.ts";
import type { Work } from "#engine/publish/work.ts";
import type { Loaded } from "#engine/scope/load.ts";

/** `--to`, else where it came from, else the saved default, else asked. */
export async function destinationOf(
  step: Interaction,
  works: readonly Work[],
  known: Readonly<Record<string, RegistrySource>>,
  to: Destination | undefined,
  namespacesOf: (alias: string) => Promise<string[]>,
  saved: Destination | undefined,
): Promise<Map<Work, { registry: string; namespace: string }> | undefined> {
  const where = new Map<Work, { registry: string; namespace: string }>();
  const homeless: Work[] = [];
  for (const work of works) {
    if (to !== undefined) where.set(work, to);
    else if (work.home?.namespace !== undefined)
      where.set(work, { registry: work.home.registry, namespace: work.home.namespace });
    else if (saved !== undefined) where.set(work, saved);
    else homeless.push(work);
  }
  if (homeless.length === 0) return where;
  if (!interactive(step)) {
    throw new AiregError(`No registry to publish ${list(homeless.map((w) => w.name))} to.`, {
      code: ErrorCode.Usage,
      hint: "Name one: `aireg publish <path> --to <registry>/<namespace>`.",
    });
  }
  const registry = await chooseRegistry(step, known, {
    message: "Publish to which registry?",
    missing: "No registry is declared to publish to.",
    usage: (aliases) =>
      `Name one: \`aireg publish <path> --to <registry>/<namespace>\`, such as ${aliases}.`,
  });
  if (registry === undefined) return undefined;
  const namespaces = await namespacesOf(registry);
  if (namespaces.length === 0) {
    throw new AiregError(`${registry} has no namespace yet.`, {
      code: ErrorCode.NotFound,
      hint: `Name a new one: \`aireg publish <path> --to ${registry}/<namespace>\`.`,
    });
  }
  const namespace = await select<string>(
    {
      message: "Into which namespace?",
      style: step.printer.errStyle,
      initial: namespaces[0] as string,
      options: namespaces.map((name) => ({ value: name, label: name })),
    },
    step.io,
  );
  if (canceled(namespace)) return undefined;
  for (const work of homeless) where.set(work, { registry, namespace });
  return where;
}

export function intoClone(
  works: readonly Work[],
  alias: string,
  to: Destination | undefined,
  cwd: string,
): string {
  const going = works.filter((work) => (to?.registry ?? work.home?.registry) === alias);
  const only = going.length === 1 ? going[0] : undefined;
  const namespace = to?.namespace ?? only?.home?.namespace ?? "<namespace>";
  const what = only === undefined ? "" : ` ${only.row ?? (relative(cwd, only.path) || ".")}`;
  return `aireg publish${what} --to <folder>/${namespace}`;
}

export async function destinationFrom(
  raw: string | undefined,
  cwd: string,
  known: Record<string, RegistrySource>,
): Promise<{ to: Destination | undefined; checkout: Checkout | undefined }> {
  if (raw === undefined) return { to: undefined, checkout: undefined };
  if (!isLocalPath(raw)) return { to: parseTo(raw), checkout: undefined };
  const folder = await folderTo(raw, cwd);
  known[folder.destination.registry] = folder.declared;
  const inGit = await gitIn(folder.declared.location, ["rev-parse", "--is-inside-work-tree"]);
  if (inGit.code !== 0) return { to: folder.destination, checkout: undefined };
  // Nothing in a git checkout reaches anyone until git pushes it. The `cd` there stays
  // short, from real paths on both sides, however --to was typed.
  const at = relative(canonical(cwd), canonical(folder.declared.location)) || ".";
  return { to: folder.destination, checkout: { registry: folder.destination.registry, at } };
}

/** A registry folder inside a git checkout, and where to `cd` to commit in it. */
interface Checkout {
  registry: string;
  at: string;
}

export function nameOne(works: Work[], to: Destination | undefined, explicit: boolean): void {
  if (to?.name === undefined) return;
  if (!explicit) {
    throw new AiregError("--to names one artifact, so it needs the path to publish.", {
      code: ErrorCode.Usage,
      hint: "Name it: `aireg publish <path> --to <registry>/<namespace>/<name>`.",
    });
  }
  if (works.length !== 1)
    throw new AiregError(
      `--to names one artifact, but ${plural(works.length, "artifact")} were given.`,
      {
        code: ErrorCode.Usage,
        hint: "Publish them one at a time, or leave the name off `--to`.",
      },
    );
  (works[0] as Work).name = to.name;
}

/** Where this run sends work, and what of it the manifest's exports keep from going there. */
interface Bound {
  works: Work[];
  skipped: Skipped[];
  to: Destination | undefined;
  checkout: Checkout | undefined;
  /** The `publish.to` target, as the manifest writes it. */
  target: string | undefined;
}

export async function boundFor(
  works: Work[],
  manifest: Manifest,
  typed: string | undefined,
  given: { to: Destination | undefined; checkout: Checkout | undefined },
  known: Record<string, RegistrySource>,
  dirs: { base: string; cwd: string },
): Promise<Bound> {
  if (manifest.publish === undefined)
    return { ...forTarget(works, dirs.base), ...given, target: undefined };
  if (!works.some((work) => work.exported !== undefined))
    return { works, skipped: [], ...given, target: undefined };
  const { to } = given;
  const folder = typed !== undefined && isLocalPath(typed) ? to : undefined;
  const root = folder === undefined ? undefined : known[folder.registry]?.location;
  const target = chooseTarget(
    manifest.publish.to,
    typed,
    (listed) => to !== undefined && namesTarget(listed, to, root, dirs.base),
  );
  const chosen =
    to === undefined
      ? await destinationFrom(target, isLocalPath(target) ? dirs.base : dirs.cwd, known)
      : given;
  return { ...forTarget(works, dirs.base), ...chosen, target };
}

export async function writableFirst(
  to: Destination | undefined,
  manifest: Manifest,
  known: Readonly<Record<string, RegistrySource>>,
  cwd: string,
): Promise<Record<string, RegistrySource> | undefined> {
  const planned = manifest.exports.length > 0 && manifest.publish !== undefined;
  return to === undefined && !planned ? writableRegistries(known, cwd) : undefined;
}

export function refuseUndeclared(
  destination: Destination | undefined,
  known: Readonly<Record<string, RegistrySource>>,
  loaded: Loaded,
): void {
  if (destination === undefined || known[destination.registry] !== undefined) return;
  throw unknownRegistry(destination.registry, loaded.roots.scope, Object.keys(known), {
    searched: knownIn(loaded.roots.scope),
  });
}

export async function savedDefault(
  known: Readonly<Record<string, RegistrySource>>,
): Promise<Destination | undefined> {
  const declared = (await readConfig()).defaults.namespace;
  const fallback = declared === undefined ? undefined : parseTo(declared);
  return fallback !== undefined && known[fallback.registry] !== undefined ? fallback : undefined;
}
