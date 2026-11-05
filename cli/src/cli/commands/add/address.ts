import { list, plural, quoted, sanitizeName, withoutCredentials } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { chooseRegistry } from "#cli/prompt/choose-registry.ts";
import { type Interaction, preparing } from "#cli/prompt/interaction.ts";
import { canAnimate, spinner } from "#cli/prompt/spinner.ts";
import { type Entry, withoutCoveredLeaves } from "#core/catalog/catalog.ts";
import { withheldAt, withheldMessage } from "#core/catalog/withheld.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { RegistrySource } from "#core/manifest/model.ts";
import { parseRef } from "#core/ref.ts";
import { abbreviate } from "#core/term/printer.ts";
import {
  among,
  atAddress,
  insideRegistry,
  type Probed,
  probeAddress,
  type Resolved,
  type SourceFlags,
  throughManifest,
  throughRegistry,
  wantOf,
} from "#engine/address/probe.ts";
import {
  type Addressing,
  aliasFor,
  asAddress,
  knownRegistries,
  undeclaredRegistry,
} from "#engine/address/registries.ts";
import type { CommonOptions } from "#engine/options.ts";
import type { AddFlags, Parsed } from "./options.ts";

/** Undefined when canceled. */
export async function openAddress(
  context: CommandContext,
  { positionals, common, own }: Parsed,
  step: Interaction,
) {
  // A project that installs through a user alias records it as its own.
  const declared = await knownRegistries(common, context.cwd);
  const typed = own.registry ?? positionals[0] ?? (await chooseRegistry(step, declared));
  if (typed === undefined) return undefined;
  const address = await commandLineAddress(own, positionals, typed, declared, common, context.cwd);
  const { input, inside: within, exact, picks, known } = address;
  let { resolved } = address;
  if (!resolved.declared) {
    const unknown = await undeclaredRegistry(input, known, common, context.cwd);
    if (unknown !== undefined) throw unknown;
  }

  let namespace = selectScope(input, resolved, picks, within);
  let { asked, named, partial } = selection(resolved, picks);
  // Only a bare address is asked about.
  const complete = picks.select !== undefined || exact;
  const asking: Interaction = complete
    ? { ...step, blocked: step.blocked ?? { kind: "yes" } }
    : step;
  preparing(asking);

  const { source } = await read(step, context, resolved, partial, named, namespace);
  const short = shortForm(source, resolved, namespace, picks);
  if (short !== undefined) {
    resolved = short;
    namespace = undefined;
    ({ asked, named, partial } = selection(resolved, picks));
  }
  const { catalogAlias, entries } = entriesFor(source, resolved, partial, namespace);

  const alias = resolved.declared
    ? aliasFor(input, true, known, source)
    : (own.as ?? aliasFor(input, false, known, source));
  return {
    alias,
    // Not `known`: for an undeclared repository that holds a stand-in the scope never declared.
    declared,
    input,
    within,
    resolved,
    asked,
    partial,
    asking,
    source,
    catalogAlias,
    entries,
  };
}

async function commandLineAddress(
  own: AddFlags,
  positionals: string[],
  typed: string,
  known: Readonly<Record<string, RegistrySource>>,
  common: CommonOptions,
  cwd: string,
): Promise<Addressed> {
  // A named adapter reads a folder its own way, so it is handed the path unchanged.
  const link =
    own.registry === undefined && own.adapter === undefined && positionals.length === 1
      ? await insideRegistry(typed, cwd)
      : undefined;
  if (link === undefined) return addressed(typed, own.registry, positionals, known, own, common);
  const flags = { ...own, ref: own.ref ?? link.flags.ref, path: own.path ?? link.flags.path };
  return addressed(link.registry, link.registry, [link.address], known, flags, common);
}

/** With --registry, one positional is an address inside it and several are picks. */
function addressed(
  typed: string,
  registry: string | undefined,
  positionals: string[],
  known: Readonly<Record<string, RegistrySource>>,
  flags: SourceFlags,
  common: CommonOptions,
): Addressed {
  if (registry === undefined) {
    refuseExtra(positionals);
    return through(asAddress(typed, known), flags, common);
  }
  // One word reads as -s reads it, an artifact before a namespace, unless -s
  // picks inside it; then it is the namespace to pick from.
  const [first] = positionals;
  const oneWord = first !== undefined && !first.includes("/") && common.select === undefined;
  if (positionals.length > 1 || oneWord) {
    if (common.select !== undefined && !common.all) {
      throw new AiregError("Names were given both as arguments and with -s.", {
        code: ErrorCode.Usage,
        hint: "Use one: `aireg add <namespace>/<name>... -r <registry>` or `aireg add <namespace> -r <registry> -s <name>`.",
      });
    }
    const whole = through(asAddress(typed, known), flags, common);
    return { ...whole, picks: { ...common, select: common.select ?? positionals }, exact: true };
  }
  const relative = first;
  if (relative === undefined) return through(asAddress(typed, known), flags, common);
  const resolved = throughRegistry(typed, relative, known, flags);
  return resolved.declared
    ? {
        input: `${typed}/${relative}`,
        resolved,
        picks: common,
        inside: undefined,
        exact: true,
        known,
      }
    : { input: typed, resolved, picks: common, inside: relative, exact: true, known };
}

function refuseExtra(positionals: readonly string[]): void {
  if (positionals.length <= 1) return;
  throw new AiregError("`aireg add` takes one address.", {
    code: ErrorCode.Usage,
    hint: "Pick several inside it: `aireg add <registry>[/<namespace>] -s <name> -s <name>`.",
  });
}

/**
 * A namespace address narrows the catalog, so `-s` cannot reach past it. A plugin's
 * namespace holds its parts and the plugin itself, which sits in none.
 */
function inside(entries: readonly Entry[], namespace: string | undefined): readonly Entry[] {
  if (namespace === undefined) return entries;
  return entries.filter(
    (entry) => entry.group === namespace || (entry.kind === "plugin" && entry.name === namespace),
  );
}

function through(
  { address: input, known }: Addressing,
  flags: SourceFlags,
  common: CommonOptions,
): Addressed {
  const resolved = throughManifest(input, known, flags);
  const exact = resolved.declared && input.includes("/");
  return { input, resolved, picks: common, inside: undefined, exact, known };
}

/** The namespace `-s` reads inside; none when the address already names one artifact. */
function selectScope(
  input: string,
  resolved: Resolved,
  common: CommonOptions,
  within: string | undefined,
): string | undefined {
  if (resolved.name !== undefined) {
    if (common.select === undefined || common.all) return undefined;
    throw new AiregError(`${quoted(input)} names one artifact, so -s has nothing to pick.`, {
      code: ErrorCode.Usage,
      hint: "Drop -s, or end the address at a registry or namespace to pick inside it.",
    });
  }
  // A declared address carries its registry; an address given after -r does not.
  const scope = resolved.declared ? input : within && `registry/${within}`;
  if (!scope) return undefined;
  try {
    const namespace = parseRef(scope).namespace;
    return namespace === undefined ? undefined : sanitizeName(namespace);
  } catch {
    return undefined;
  }
}

function selection(resolved: Resolved, picks: CommonOptions) {
  const asked: CommonOptions =
    picks.select !== undefined || resolved.name === undefined
      ? picks
      : { ...picks, select: [resolved.name] };
  // Only one address is read on its own: a `--select` value may name a
  // namespace, which the catalog has to be read to recognize.
  return {
    asked,
    named: asked.select?.includes("*") === true ? undefined : asked.select,
    partial: resolved.name !== undefined && picks.select === undefined,
  };
}

interface Addressed {
  input: string;
  resolved: Resolved;
  picks: CommonOptions;
  /** With --registry, the address inside it. */
  inside: string | undefined;
  /** The command line says exactly what to install, so nothing is asked. */
  exact: boolean;
  known: Readonly<Record<string, RegistrySource>>;
}

async function read(
  step: Interaction,
  context: CommandContext,
  resolved: Resolved,
  partial: boolean,
  named: readonly string[] | undefined,
  namespace: string | undefined,
): Promise<{ source: Probed }> {
  const spin =
    context.printer.quiet || context.printer.format === "json" || !canAnimate(step.io.output)
      ? undefined
      : spinner(step.io, context.printer.errStyle);
  spin?.update(`Reading ${showable(resolved)}`);
  let source: Probed;
  try {
    source = await probeAddress(resolved, context.cwd, partial ? wantOf(resolved) : []);
  } catch (error) {
    spin?.stop();
    throw error;
  }

  const registry = resolved.alias ?? source.alias;
  const catalog = source.catalog;
  const withheld = withheldAt(catalog.withheld, { ...resolved, group: resolved.namespace });
  if (withheld !== undefined) {
    spin?.stop();
    throw new AiregError(`${withheldMessage(withheld)}, so nothing was installed.`, {
      code: ErrorCode.Invalid,
      hint:
        withheld.status === "blocked"
          ? "Pin another version, or ask the registry's owner why this one is blocked."
          : `Pin the version, as in \`@${withheld.version}\`, to install it before its release.`,
    });
  }
  if (catalog.entries.length === 0) {
    spin?.stop();
    throw new AiregError(
      named === undefined
        ? `${registry} publishes no artifacts.`
        : `${registry} publishes nothing named ${list(named.map(quoted), "or")}.`,
      {
        code: ErrorCode.NotFound,
        hint: `Run \`aireg registry show ${showable(resolved)}\` to see what it publishes.`,
      },
    );
  }

  // Whole-registry installs skip leaves a plugin already covers; an address
  // may still name one of them.
  const publishes = withoutCoveredLeaves(catalog.entries);
  const at = source.revision === undefined ? "" : ` at ${abbreviate(source.revision)}`;
  // The cap counts the namespace on its own, so its count is shown beside the source's.
  const within =
    namespace === undefined
      ? ""
      : `, ${withoutCoveredLeaves(inside(catalog.entries, namespace)).length} in ${namespace}`;
  spin?.stop(`${registry}${at} publishes ${plural(publishes.length, "artifact")}${within}`);

  return { source };
}

/**
 * `acme/pdf` names a namespace, or, when there is none but exactly one artifact `pdf`,
 * that artifact; the manifest records its full name.
 */
function shortForm(
  source: Probed,
  resolved: Resolved,
  namespace: string | undefined,
  picks: CommonOptions,
): Resolved | undefined {
  if (namespace === undefined || resolved.name !== undefined || picks.select !== undefined) {
    return undefined;
  }
  const entries = source.catalog.entries;
  const plugin = (entry: Entry) => entry.kind === "plugin" && entry.name === namespace;
  if (entries.some((entry) => entry.group === namespace || plugin(entry))) return undefined;
  const [only] = among(entries, resolved.alias ?? source.alias, { name: namespace });
  if (only === undefined) return undefined;
  return { ...resolved, name: only.name, namespace: only.group, kind: only.kind };
}

function entriesFor(
  source: Probed,
  resolved: Resolved,
  partial: boolean,
  namespace: string | undefined,
): { catalogAlias: string; entries: readonly Entry[] } {
  const catalogAlias = resolved.alias ?? source.alias;
  const all = source.catalog.entries;
  const entries = partial ? atAddress(resolved, all, catalogAlias) : inside(all, namespace);
  const plugin = (entry: Entry) => entry.kind === "plugin" && entry.name === namespace;
  if (namespace !== undefined && entries.length === 0 && !all.some(plugin)) {
    throw new AiregError(`No namespace named ${quoted(namespace)} in ${catalogAlias}.`, {
      code: ErrorCode.NotFound,
      hint: `Run \`aireg registry show ${showable(resolved)}\` to see what it publishes.`,
    });
  }
  return { catalogAlias, entries };
}

export function showable(resolved: Resolved): string {
  return resolved.alias ?? withoutCredentials(resolved.input);
}
