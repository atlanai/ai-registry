import { resolve, sep } from "node:path";
import { namesHost, registryNameFromLocation } from "#adapter/location.ts";
import { isLocalPath } from "#adapter/paths.ts";
import { list, quoted, stripTrailing, withoutCredentials } from "#adapter/text.ts";
import { splitRepository } from "#adapters/git/api.ts";
import { type Interaction, interactive } from "#cli/prompt/flow.ts";
import { canceled, select } from "#cli/prompt/index.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonical } from "#core/fs/canonical.ts";
import { expandUserPath } from "#core/fs/path.ts";
import { type RegistrySource, readManifest, unknownRegistry } from "#core/manifest.ts";
import { roots as makeRoots, type Scope, scopeName } from "#core/store/paths.ts";
import type { CommonOptions } from "#engine/options.ts";
import { load } from "#engine/pipeline.ts";
import type { Probed } from "./source.ts";

/** The alias a location is already declared under, so a second spelling of it reuses the name. */
function declaredAlias(
  registries: Readonly<Record<string, RegistrySource>>,
  location: string,
): string | undefined {
  const wanted = comparable(location);
  return Object.keys(registries)
    .sort()
    .find((alias) => comparable(registries[alias]?.location ?? "") === wanted);
}

export function sameLocation(a: string, b: string): boolean {
  return comparable(a) === comparable(b);
}

/**
 * A folder is the folder the filesystem means: `team` and `team.git`, or `ACME` and `acme`
 * on a case-sensitive disk, are two registries. A URL is matched however it is spelled.
 */
function comparable(location: string): string {
  if (isLocalPath(location)) {
    const path = canonical(resolve(expandUserPath(location)));
    return `path:${path.length > 1 ? stripTrailing(path, sep) : path}`;
  }
  const bare = location
    .trim()
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/\.git$/, "");
  return `url:${stripTrailing(bare, "/").toLowerCase()}`;
}

/**
 * An address keeps the alias it named; a URL takes the alias it is already
 * declared under, and only a new source is named after itself.
 */
export function aliasFor(
  input: string,
  declared: boolean,
  known: Readonly<Record<string, RegistrySource>>,
  source: Probed,
): string {
  if (declared) return input.split("/")[0] as string;
  return declaredAlias(known, source.declared.location) ?? source.alias;
}

/**
 * This scope's registries over the user's, so a project sees every alias its
 * user declared. A relative folder is read from the scope that declares it.
 */
export async function knownRegistries(
  common: CommonOptions,
  cwd: string,
): Promise<Record<string, RegistrySource>> {
  const here = await load(common, cwd, "user");
  const own = rooted(here.manifest.registries, here.roots.base);
  if (here.roots.scope === "user") return own;
  const user = makeRoots("user", cwd);
  return { ...rooted((await readManifest(user.manifest)).registries, user.base), ...own };
}

function rooted(
  registries: Readonly<Record<string, RegistrySource>>,
  base: string,
): Record<string, RegistrySource> {
  return Object.fromEntries(
    Object.entries(registries).map(([alias, source]) => [
      alias,
      source.location.startsWith(".")
        ? { ...source, location: expandLocation(source.location, base) }
        : source,
    ]),
  );
}

/**
 * With nothing named, a terminal offers what is declared; anywhere else that
 * is a usage error, because there is nobody to ask.
 */
export async function chooseRegistry(
  step: Interaction,
  known: Readonly<Record<string, RegistrySource>>,
  ask: { message: string; missing: string; usage: (aliases: string) => string } = {
    message: "Install from which registry?",
    missing: "`aireg add` needs a registry.",
    usage: (aliases) => `Name the registry: \`aireg add <registry>\`, such as ${aliases}.`,
  },
): Promise<string | undefined> {
  const aliases = Object.keys(known).sort();
  if (!interactive(step) || aliases.length === 0) {
    throw new AiregError(ask.missing, {
      code: ErrorCode.Usage,
      hint:
        aliases.length === 0
          ? "Declare one first with `aireg registry add <address>`, such as github.com/owner/repo or a folder."
          : ask.usage(list(aliases, "or")),
    });
  }
  const picked = await select<string>(
    {
      message: ask.message,
      style: step.printer.errStyle,
      initial: aliases[0] as string,
      options: aliases.map((alias) => ({
        value: alias,
        label: alias,
        hint: withoutCredentials(known[alias]?.location ?? ""),
      })),
    },
    step.io,
  );
  return canceled(picked) ? undefined : picked;
}

/**
 * A repository URL with an address after it names a place inside that
 * registry, so `github.com/acme/registry/platform` is `<alias>/platform`.
 */
export function asAddress(input: string, known: Record<string, RegistrySource>): string {
  const split = splitRepository(input);
  if (split === undefined) return input;
  const alias =
    declaredAlias(known, split.location) ?? registryNameFromLocation(split.location, "git");
  // The name is the repository's only when it is free: a declaration of another
  // source under it would otherwise be read in place of the repository named.
  const holder = known[alias];
  if (holder !== undefined && !sameLocation(holder.location, split.location)) {
    throw new AiregError(
      `The name ${quoted(alias)} is already taken by ${withoutCredentials(holder.location)}.`,
      {
        code: ErrorCode.Usage,
        hint: `Declare ${split.location} under another name with \`aireg registry add ${split.location} --as <name>\`, then add <name>/${split.rest}.`,
      },
    );
  }
  known[alias] ??= { location: split.location, adapter: undefined, config: {} };
  return `${alias}/${split.rest}`;
}

/**
 * An address whose registry this scope does not know. The likeliest cause is the
 * other scope, so a registry declared there is named with the flag that reaches it.
 */
export async function undeclaredRegistry(
  input: string,
  known: Readonly<Record<string, RegistrySource>>,
  common: CommonOptions,
  cwd: string,
): Promise<AiregError | undefined> {
  if (namesHost(input)) return undefined;
  const alias = (input.split("@")[0] ?? input).split("/")[0] ?? input;
  const scope = (await load(common, cwd, "user")).roots.scope;
  const project =
    common.scope === "user" ? await load({ ...common, scope: undefined }, cwd, "user") : undefined;
  const there =
    project?.roots.scope === "project" && project.manifest.registries[alias] !== undefined;
  return unknownRegistry(
    alias,
    scope,
    Object.keys(known),
    there
      ? `This project declares ${alias}, so run it without -g, or add it to your user scope with \`aireg registry add <address> -g\`.`
      : undefined,
    knownIn(scope),
  );
}

/** A project also reaches the registries your user scope declares, so both were looked in. */
export function knownIn(scope: Scope): string {
  return scope === "project" ? "this project or your user scope" : scopeName(scope);
}
