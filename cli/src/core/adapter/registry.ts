import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ADAPTER_PROTOCOL,
  type Dispatch,
  type SourceAdapter,
  type SourceLimits,
} from "#adapter/index.ts";
import { isLocalPath } from "#adapter/paths.ts";
import { list, quoted, withoutCredentials } from "#adapter/text.ts";
import {
  assertInstallRecord,
  parseDispatch,
  readInstallRecord,
} from "#core/adapter/installed/record.ts";
import { readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { toolHome } from "#core/store/paths.ts";

type Loader = () => Promise<unknown>;

/** What every adapter is allowed unless the host says otherwise for it. */
const DEFAULT_LIMITS: SourceLimits = { timeoutMs: 30_000, retries: 3 };

const BUILTIN = new Map<string, Loader>();
const LIMITS = new Map<string, () => Partial<SourceLimits>>();
let fallback: string | undefined;

/** Built-in adapters ship in the CLI; config and origin install cannot replace them. */
export function isBuiltinAdapter(id: string): boolean {
  return BUILTIN.has(id);
}

/** The application composition root owns which adapters it bundles. */
export function registerBuiltinAdapter(
  id: string,
  loader: Loader,
  options: { fallback?: boolean; limits?: () => Partial<SourceLimits> } = {},
): void {
  BUILTIN.set(id, loader);
  if (options.limits !== undefined) LIMITS.set(id, options.limits);
  if (options.fallback === true) fallback = id;
}

/** Read when each connection opens, so a setting changed since startup applies. */
export function limitsFor(id: string): SourceLimits {
  return { ...DEFAULT_LIMITS, ...LIMITS.get(id)?.() };
}

/** User config is the only source of dynamic modules; project manifests are untrusted. */
async function configured(): Promise<Record<string, string>> {
  return { ...(await readConfig()).adapters };
}

async function adapterIds(): Promise<string[]> {
  return [...new Set([...BUILTIN.keys(), ...Object.keys(await configured())])].sort();
}

function looksLikeAdapter(value: unknown): value is SourceAdapter {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SourceAdapter>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.displayName === "string" &&
    candidate.protocol === ADAPTER_PROTOCOL &&
    Array.isArray(candidate.artifactKinds) &&
    parseDispatch(candidate.dispatch) !== undefined &&
    typeof candidate.capabilities === "object" &&
    typeof candidate.connect === "function"
  );
}

function validate(module: unknown, id: string, where: string): SourceAdapter {
  const exports = (module ?? {}) as Record<string, unknown>;
  const adapter = [exports.default, exports.adapter, exports[id], module].find(looksLikeAdapter);
  if (adapter === undefined) {
    throw new AiregError(
      `${where} exports no adapter for ${quoted(id)}. Export it as \`default\`, \`adapter\`, ` +
        `or \`${id}\`: an adapter implementing protocol ${ADAPTER_PROTOCOL}.`,
      { code: ErrorCode.Invalid },
    );
  }
  if (adapter.id !== id) {
    throw new AiregError(
      `${where} is registered as ${quoted(id)}, but its id is ${quoted(adapter.id)}.`,
      { code: ErrorCode.Invalid },
    );
  }
  return adapter;
}

const loaded = new Map<string, SourceAdapter>();

function moduleFile(specifier: string): string | undefined {
  if (isAbsolute(specifier)) return specifier;
  if (specifier.startsWith(".")) return join(toolHome(), specifier);
  return undefined;
}

function moduleUrl(specifier: string): string {
  const file = moduleFile(specifier);
  return file === undefined ? specifier : pathToFileURL(file).href;
}

/** Load a file we just wrote, so install can record dispatch without going through config. */
export async function inspectAdapterModule(path: string, id: string): Promise<SourceAdapter> {
  return validate(await import(pathToFileURL(path).href), id, path);
}

async function specifierFor(id: string): Promise<string | undefined> {
  if (isBuiltinAdapter(id)) return undefined;
  return (await configured())[id];
}

export async function loadAdapter(id: string): Promise<SourceAdapter> {
  const specifier = await specifierFor(id);
  const builtin = specifier === undefined ? BUILTIN.get(id) : undefined;
  const cacheKey = specifier ?? (builtin !== undefined ? `builtin:${id}` : id);
  const cached = loaded.get(cacheKey);
  if (cached !== undefined) return cached;

  let adapter: SourceAdapter;
  if (specifier !== undefined) {
    const file = moduleFile(specifier);
    if (file !== undefined) await assertInstallRecord(file, id);
    adapter = validate(await import(moduleUrl(specifier)), id, specifier);
  } else if (builtin !== undefined) {
    adapter = validate(await builtin(), id, `the "${id}" adapter`);
  } else {
    throw new AiregError(`Unknown adapter ${quoted(id)}.`, {
      code: ErrorCode.NotFound,
      hint: `Use ${list(await adapterIds(), "or")}.`,
    });
  }

  loaded.set(cacheKey, adapter);
  return adapter;
}

function urlParts(spec: string): { scheme?: string; host?: string } {
  try {
    const url = new URL(spec);
    return { scheme: url.protocol.replace(/:$/, ""), host: url.hostname.toLowerCase() };
  } catch {
    return {};
  }
}

/** Every adapter, loaded or with why not, so one broken module costs only its own adapter. */
export async function loadAdapters(): Promise<{
  loaded: SourceAdapter[];
  broken: { id: string; error: unknown }[];
}> {
  const ids = await adapterIds();
  const settled = await Promise.allSettled(ids.map(loadAdapter));
  const loaded: SourceAdapter[] = [];
  const broken: { id: string; error: unknown }[] = [];
  settled.forEach((result, at) => {
    if (result.status === "fulfilled") loaded.push(result.value);
    else broken.push({ id: ids[at] as string, error: result.reason });
  });
  return { loaded, broken };
}

const onHost = (host: string | undefined, candidates: readonly string[] | undefined) =>
  candidates?.some(
    (candidate) => host === candidate || host?.endsWith(`.${candidate}`) === true,
  ) === true;

/** A site claim takes a URL of its scheme unless its host or the end of its path is left out. */
function onSite(dispatch: Dispatch, spec: string, scheme: string | undefined): boolean {
  const sites = dispatch.sites;
  if (sites === undefined || scheme === undefined || !sites.schemes.includes(scheme)) return false;
  const { host } = urlParts(spec);
  if (onHost(host, sites.exceptHosts)) return false;
  const path = spec.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return !(sites.exceptSuffixes ?? []).some((suffix) => path.endsWith(suffix));
}

/**
 * Lower is more specific. A host claim beats a site claim, which beats a scheme claim, so a
 * registry on https wins over the general-purpose adapter that also speaks https.
 */
function tier(dispatch: Dispatch, spec: string): number | undefined {
  if (isLocalPath(spec)) return dispatch.paths === true ? 0 : undefined;
  const { scheme, host } = urlParts(spec);
  if (host !== undefined && onHost(host, dispatch.hosts)) return 0;
  if (onSite(dispatch, spec, scheme)) return 1;
  if (scheme !== undefined && dispatch.schemes?.includes(scheme) === true) return 2;
  return undefined;
}

async function dispatchOf(id: string): Promise<Dispatch> {
  const specifier = await specifierFor(id);
  if (specifier !== undefined) {
    const file = moduleFile(specifier);
    if (file !== undefined) {
      const record = await readInstallRecord(file);
      if (record !== undefined) return record.dispatch;
    }
  }
  return (await loadAdapter(id)).dispatch;
}

/** Only a URL or a path can be claimed; shorthand always goes to the fallback. */
function claimable(spec: string): boolean {
  return isLocalPath(spec) || urlParts(spec).scheme !== undefined;
}

/** Loopback as the secure contexts spec counts it: no network carries the bytes. */
function isLoopback(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]") return true;
  // The URL parser has already turned 0x7f.1 and 2130706433 into dotted decimal.
  return /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** A registry read in cleartext could be rewritten by anyone on the network before its commit is pinned. */
export function refuseInsecure(spec: string): void {
  const { scheme, host } = urlParts(spec);
  const shown = quoted(withoutCredentials(spec));
  if (scheme === "git") {
    throw new AiregError(`${shown} uses git://, which has no transport security.`, {
      code: ErrorCode.Usage,
      hint: "Add its https:// or ssh:// address instead.",
    });
  }
  if (scheme === "http" && !isLoopback(host ?? "")) {
    throw new AiregError(`${shown} uses http://, which has no transport security.`, {
      code: ErrorCode.Usage,
      hint: "Add its https:// address instead. Plain http:// is allowed only on this machine, such as http://localhost.",
    });
  }
}

/**
 * Named wins, then a declared match, then the fallback. Matching is data, so a
 * configured adapter with an install record is scored without importing it.
 */
export async function adapterFor(spec: string, named: string | undefined): Promise<SourceAdapter> {
  refuseInsecure(spec);
  if (named !== undefined) return loadAdapter(named);

  const scored: { id: string; tier: number }[] = [];
  let broken: { id: string; error: unknown } | undefined;
  for (const id of await adapterIds()) {
    let dispatch: Dispatch;
    try {
      dispatch = await dispatchOf(id);
    } catch (error) {
      if (isBuiltinAdapter(id)) throw error;
      broken ??= { id, error };
      continue;
    }
    const rank = tier(dispatch, spec);
    if (rank !== undefined) scored.push({ id, tier: rank });
  }
  // A broken adapter might claim this source, so another adapter must not quietly take it.
  if (broken !== undefined && claimable(spec)) {
    const reason = broken.error instanceof Error ? broken.error.message : String(broken.error);
    throw new AiregError(
      `The ${quoted(broken.id)} adapter failed to load: ${reason.replace(/\.$/, "")}.`,
      {
        code: ErrorCode.Invalid,
        hint: `Fix its module, or remove it with \`aireg adapter remove ${broken.id}\`.`,
      },
    );
  }
  const best = Math.min(...scored.map((entry) => entry.tier));
  const matched = scored.filter((entry) => entry.tier === best).map((entry) => entry.id);

  if (matched.length > 1) {
    throw new AiregError(
      `More than one adapter reads ${quoted(withoutCredentials(spec))}: ${list(matched.sort())}.`,
      {
        code: ErrorCode.Usage,
        hint: "Name the one you mean with `adapter:` in the manifest, or `--adapter`.",
      },
    );
  }
  const only = matched[0];
  if (only !== undefined) return loadAdapter(only);
  if (fallback !== undefined) return loadAdapter(fallback);
  throw new AiregError(`No adapter recognizes ${spec}.`, {
    code: ErrorCode.Usage,
    hint: `Name its adapter with \`adapter:\` in the manifest, or \`--adapter\`: ${list(await adapterIds(), "or")}.`,
  });
}
