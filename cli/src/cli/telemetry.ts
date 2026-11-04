import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ID as GIT, parseSource } from "#adapters/git/api.ts";
import { ID as LOCAL } from "#adapters/local/api.ts";
import { ID as WELL_KNOWN } from "#adapters/well-known/api.ts";
import { callingAgent, SIGNALS } from "#cli/prompt/caller.ts";
import { readConfig } from "#core/config/repository.ts";
import { envName, isCI, present, setting } from "#core/env.ts";
import type { Lock, LockArtifact } from "#core/lock.ts";
import type { Printer } from "#core/output.ts";
import { spawnDetached } from "#core/process.ts";
import {
  DOCS_URL,
  TELEMETRY_ID_FILE,
  TELEMETRY_NOTICE_FILE,
  TELEMETRY_PATH,
} from "#core/product.ts";
import { launchArgv, runningEntry } from "#core/release/launch.ts";
import { stampedOrigin } from "#core/release/stamp.ts";
import { ensureHome } from "#core/store/paths.ts";
import { VERSION } from "#core/version.ts";
import type { RunResult } from "#engine/pipeline.ts";
import { BUILTIN_TARGETS } from "#targets/index.ts";

export const TELEMETRY_FLAG = "--internal-telemetry";

/** Each request the background sender makes, and the sender as a whole, give up after these. */
const REQUEST_TIMEOUT_MS = 3000;
const SENDER_TIMEOUT_MS = 10_000;
const GITHUB_API = "https://api.github.com";
const QUERY_LIMIT = 100;
const NAMES_LIMIT = 50;
const GITHUB_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OFF_SWITCHES = ["DO_NOT_TRACK", envName("DISABLE_TELEMETRY")];
/** Kept only once GitHub confirms every repository the event came from is public. */
const NAMING_FIELDS = ["source", "artifacts", "query"] as const;

type SourceType = "github" | "git" | "local" | "well-known" | "other";
type Registry = { location: string; adapter: string | undefined };

interface Named {
  sourceType: SourceType;
  kinds: string;
  source?: string;
  artifacts?: string;
}

/** Every event and field aireg can send. */
type UsageEvent =
  | ({
      event: "install" | "remove";
      agents: string;
      global?: "1";
      trigger?: "add" | "install";
    } & Named)
  | ({ event: "publish" } & Named)
  | { event: "update"; artifactCount: string; updatedCount: string; global?: "1" }
  | { event: "search"; resultCount: string; kind?: string; query?: string }
  | { event: "sync"; registryCount: string; changedCount: string; failedCount: string };

/** An event as a command records it, with the repositories GitHub must confirm are public. */
export interface Queued {
  event: UsageEvent;
  github?: readonly string[] | undefined;
}

export type TelemetryState =
  | { on: true; url: string }
  | { on: false; why: "opted-out"; switch: string }
  | { on: false; why: "config" }
  | { on: false; why: "source-build" };

export function telemetryState(
  env: NodeJS.ProcessEnv = process.env,
  origin: string | undefined = stampedOrigin(),
  saved = true,
): TelemetryState {
  const off = OFF_SWITCHES.find((name) => present(name, env));
  if (off !== undefined) return { on: false, why: "opted-out", switch: off };
  if (!saved) return { on: false, why: "config" };
  const url =
    setting("TELEMETRY_URL", env) ?? (origin === undefined ? undefined : origin + TELEMETRY_PATH);
  return url === undefined ? { on: false, why: "source-build" } : { on: true, url };
}

/** With the saved `telemetry` setting read; a config that cannot be read sends nothing. */
export async function savedTelemetryState(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TelemetryState> {
  const saved = await readConfig(env).then(
    (config) => config.telemetry,
    () => false,
  );
  return telemetryState(env, stampedOrigin(), saved);
}

const pending: Queued[] = [];

/** Bumped when the notice says something materially new, so it is shown again. */
const NOTICE_VERSION = "1";

/**
 * Shown once per aireg home before anything is sent: the run that shows it sends
 * nothing, so a person can turn events off before the first one leaves.
 */
export async function noticeFirst(
  printer: Printer,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!(await savedTelemetryState(env)).on) return;
  try {
    const file = join(ensureHome(env), TELEMETRY_NOTICE_FILE);
    const shown = (await readFile(file, "utf8").catch(() => "")).trim();
    if (shown === NOTICE_VERSION) return;
    printer.notice(
      [
        "aireg collects anonymous usage data to improve the CLI.",
        `  Learn more, including how to opt out: ${DOCS_URL}reference/environment/#network-and-privacy`,
      ].join("\n"),
    );
    await writeFile(file, `${NOTICE_VERSION}\n`, { mode: 0o600 });
  } catch {
    // A home that cannot be written to shows the notice again next time.
  }
  pending.splice(0);
}

function queue(item: Queued): void {
  if (telemetryState().on) pending.push(item);
}

/** Hands what the command queued to a detached sender, so no command waits on the network. */
export async function flushTelemetry(
  entry = runningEntry(),
  $spawn: typeof spawnDetached = spawnDetached,
): Promise<void> {
  const items = pending.splice(0);
  if (items.length === 0 || entry === undefined) return;
  if (!(await savedTelemetryState()).on) return;
  try {
    const launch = launchArgv(entry, [TELEMETRY_FLAG]);
    const child = $spawn(launch.command, launch.args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    await new Promise<void>((resolve) => {
      child.stdin?.on("error", () => resolve());
      child.stdin?.end(JSON.stringify(items), () => resolve());
    });
  } catch {
    // Telemetry never fails a command.
  }
}

/** The detached sender's work: drop names GitHub does not confirm are public, then send. */
export async function sendQueued(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  $fetch: typeof fetch = fetch,
): Promise<void> {
  const state = await savedTelemetryState(env);
  if (!state.on) return;
  let items: unknown;
  try {
    items = JSON.parse(input);
  } catch {
    return;
  }
  if (!Array.isArray(items)) return;
  const sends = (items as Queued[]).map(async ({ event, github = [] }) => {
    const confirmed =
      github.length > 0 &&
      (await Promise.all(github.map((slug) => isPublicOnGitHub(slug, $fetch)))).every(Boolean);
    const fields: Record<string, unknown> = { ...event };
    if (!confirmed) for (const field of NAMING_FIELDS) delete fields[field];
    const response = await $fetch(`${state.url}?${await paramsOf(fields, env)}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel();
  });
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SENDER_TIMEOUT_MS);
  });
  await Promise.race([Promise.allSettled(sends), late]);
  clearTimeout(timer);
}

async function paramsOf(
  fields: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<URLSearchParams> {
  const params = new URLSearchParams({
    event: String(fields.event),
    v: VERSION,
    os: process.platform,
    arch: process.arch,
  });
  if (isCI(env)) params.set("ci", "1");
  const agent = agentOf(env);
  if (agent !== undefined) params.set("agent", agent);
  const id = await installId(env);
  if (id !== undefined) params.set("id", id);
  for (const [key, value] of Object.entries(fields)) {
    if (key !== "event" && typeof value === "string") params.set(key, value);
  }
  return params;
}

const KNOWN_AGENTS = [...new Set(SIGNALS.map((signal) => signal.agent))];

/** `AI_AGENT` is free text, often an ID plus a version, so anything unmatched is only `other`. */
function agentOf(env: NodeJS.ProcessEnv): string | undefined {
  const declared = env.AI_AGENT?.trim().toLowerCase() ?? "";
  const named = KNOWN_AGENTS.find(
    (id) =>
      declared === id || (/^[_/@ -]/.test(declared.slice(id.length)) && declared.startsWith(id)),
  );
  if (named !== undefined) return named;
  const signaled = callingAgent({ ...env, AI_AGENT: "" });
  if (signaled !== undefined) return signaled;
  return declared === "" ? undefined : "other";
}

async function installId(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const file = join(ensureHome(env), TELEMETRY_ID_FILE);
    const stored = async () => (await readFile(file, "utf8").catch(() => "")).trim();
    const found = await stored();
    if (UUID.test(found)) return found;
    // `wx` so two senders starting at once keep one ID: the second reads the first's.
    const made = randomUUID();
    const wrote = await writeFile(file, `${made}\n`, {
      mode: 0o600,
      flag: found === "" ? "wx" : "w",
    })
      .then(() => true)
      .catch(() => false);
    if (wrote) return made;
    const theirs = await stored();
    return UUID.test(theirs) ? theirs : undefined;
  } catch {
    return undefined;
  }
}

const publicity = new Map<string, Promise<boolean>>();

/** A private repository, an error or no answer all count as private. */
function isPublicOnGitHub(slug: string, $fetch: typeof fetch): Promise<boolean> {
  let known = publicity.get(slug);
  if (known === undefined) {
    known = GITHUB_SLUG.test(slug)
      ? $fetch(`${GITHUB_API}/repos/${slug}`, {
          headers: { accept: "application/vnd.github+json", "user-agent": `aireg/${VERSION}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
          .then(async (response) => {
            if (!response.ok) return false;
            const body = (await response.json()) as { private?: unknown };
            return body.private === false;
          })
          .catch(() => false)
      : Promise.resolve(false);
    publicity.set(slug, known);
  }
  return known;
}

/** A registry's type, and its `owner/repo` when it is on github.com and so can be checked. */
export function sourceOf({ adapter, location }: Registry): {
  sourceType: SourceType;
  slug?: string;
} {
  if (adapter === LOCAL) return { sourceType: "local" };
  if (adapter === WELL_KNOWN) return { sourceType: "well-known" };
  if (adapter !== undefined && adapter !== GIT) return { sourceType: "other" };
  let spec: ReturnType<typeof parseSource>;
  try {
    spec = parseSource(location);
  } catch {
    return { sourceType: "other" };
  }
  if (spec.kind === "path") return { sourceType: "local" };
  const slug = spec.host?.toLowerCase() === "github.com" ? spec.slug : undefined;
  if (slug === undefined || !GITHUB_SLUG.test(slug)) return { sourceType: "git" };
  return { sourceType: "github", slug };
}

/** Where artifacts came from; the names are queued only for a repository GitHub can confirm. */
function named(
  registry: Registry,
  items: readonly { name: string; kind: string }[],
): Pick<Queued, "github"> & { fields: Named } {
  const { sourceType, slug } = sourceOf(registry);
  const kinds = [...new Set(items.map((item) => item.kind))].sort().join(",");
  if (slug === undefined) return { fields: { sourceType, kinds } };
  const artifacts = items
    .slice(0, NAMES_LIMIT)
    .map((item) => item.name)
    .join(",");
  return { fields: { sourceType, kinds, source: slug, artifacts }, github: [slug] };
}

const BUILTIN_TARGET_IDS = new Set<string>(BUILTIN_TARGETS.map((target) => target.id));

const userScope = (scope: RunResult["scope"]) => (scope === "user" ? { global: "1" as const } : {});

/** One event per registry the run installed from, or removed from. */
/** `trigger` says whether the install chose something new (`add`) or restored a project (`install`). */
export function trackRun(
  event: "install" | "remove",
  result: RunResult,
  trigger?: "add" | "install",
): void {
  const { applied, before, scope, targets } = result;
  const lock = event === "install" ? applied?.lock : before;
  if (applied === undefined || lock === undefined) return;
  // A target of your own is named by you, so it is sent only as `custom`.
  const agents = [...new Set(targets.map((id) => (BUILTIN_TARGET_IDS.has(id) ? id : "custom")))];
  // A restore's lockfile already records links from another machine, so it reads what this run linked.
  const installed = trigger === "install" ? applied.installed : applied.added;
  const names = event === "install" ? installed : applied.removed;
  for (const [alias, rows] of byRegistry(lock, names)) {
    const registry = lock.registries[alias];
    if (registry === undefined) continue;
    const { fields, github } = named(registry, rows);
    const agentList = agents.sort().join(",");
    const by = trigger === undefined ? {} : { trigger };
    queue({ event: { event, ...by, agents: agentList, ...userScope(scope), ...fields }, github });
  }
}

export function trackUpdate(result: RunResult): void {
  const { applied, before, scope } = result;
  const after = applied?.lock;
  if (after === undefined) return;
  const updated = Object.entries(after.artifacts).filter(([name, row]) => {
    const was = before.artifacts[name];
    return was !== undefined && (was.version !== row.version || was.content !== row.content);
  });
  const artifactCount = String(Object.keys(after.artifacts).length);
  const updatedCount = String(updated.length);
  queue({ event: { event: "update", artifactCount, updatedCount, ...userScope(scope) } });
}

export function trackPublish(
  registry: Registry,
  works: readonly { name: string; kind: string }[],
): void {
  const { fields, github } = named(registry, works);
  queue({ event: { event: "publish", ...fields }, github });
}

/** The query is kept only when every registry searched is a repository GitHub says is public. */
export function trackSearch(
  query: string,
  resultCount: number,
  kind: string | undefined,
  registries: readonly Registry[],
): void {
  const slugs = registries.flatMap((registry) => sourceOf(registry).slug ?? []);
  const checkable = slugs.length > 0 && slugs.length === registries.length;
  const event: UsageEvent = { event: "search", resultCount: String(resultCount) };
  if (kind !== undefined) event.kind = kind;
  if (checkable) event.query = query.slice(0, QUERY_LIMIT);
  queue({ event, github: checkable ? slugs : undefined });
}

export function trackSync(registryCount: number, changedCount: number, failedCount: number): void {
  queue({
    event: {
      event: "sync",
      registryCount: String(registryCount),
      changedCount: String(changedCount),
      failedCount: String(failedCount),
    },
  });
}

function byRegistry(lock: Lock, names: readonly string[]): Map<string, LockArtifact[]> {
  const grouped = new Map<string, LockArtifact[]>();
  for (const name of names) {
    const row = lock.artifacts[name];
    if (row === undefined) continue;
    grouped.set(row.registry, [...(grouped.get(row.registry) ?? []), row]);
  }
  return grouped;
}
