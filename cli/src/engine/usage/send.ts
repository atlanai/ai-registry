import { messageOf } from "#adapter/errors.ts";
import type { RegistryUsage } from "#adapter/index.ts";
import type { UsageShare } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { usageHeadersVariable } from "#core/env.ts";
import { collect } from "./collect.ts";
import type { Run, SeenRegistry } from "./model.ts";
import { reporterFor, traceRequest } from "./otlp.ts";
import { encodeTraceRequest, type TraceRequest } from "./protobuf.ts";
import { identityOf } from "./registry.ts";
import { pseudonymKey, readSent, type Sent, withUsage, writeSent } from "./store.ts";

const BATCH = 500;
const TIMEOUT_MS = 15_000;

/** What sending did for one registry you share with. */
export interface Sending {
  alias: string;
  otlp: string;
  sent: number;
  /** Runs still to send, after this pass. */
  pending: number;
  /** Why nothing more was sent, when something stopped it. */
  stopped?: string | undefined;
}

/** Counts new runs, then sends each shared registry the runs its endpoint does not have yet. */
export async function send(env: NodeJS.ProcessEnv = process.env): Promise<Sending[]> {
  const shares = (await readConfig(env)).usage;
  if (shares.length === 0) return [];
  const collected = await collect(env);
  const results: Sending[] = [];
  for (const share of shares) {
    results.push(await sendOne(share, collected.runs, collected.registries[share.registry], env));
  }
  return results;
}

async function sendOne(
  share: UsageShare,
  runs: readonly Run[],
  registry: SeenRegistry | undefined,
  env: NodeJS.ProcessEnv,
): Promise<Sending> {
  const mine = sendable(runs, share);
  return withUsage(env, async () => {
    const sent = await readSent(env);
    const from = sentCount(sent, share, mine.length);
    const result: Sending = {
      alias: share.alias,
      otlp: share.otlp,
      sent: 0,
      pending: mine.length - from,
    };
    if (result.pending === 0) return result;
    if (registry === undefined)
      return { ...result, stopped: "aireg cannot find where it was installed from" };
    const usage = await currentUsage(registry, share);
    if (typeof usage === "string") return { ...result, stopped: usage };
    const reporter = reporterFor(usage.usage, share.registry, share.as, await pseudonymKey(env));
    let count = from;
    while (count < mine.length) {
      // Turning sharing off, or agreeing to another endpoint, takes this lease: check before each batch.
      if (!(await stillShared(share, env))) {
        return {
          ...result,
          sent: count - from,
          pending: mine.length - count,
          stopped: "sharing was turned off",
        };
      }
      const batch = mine.slice(count, count + BATCH);
      const failure = await post(share, traceRequest(batch, usage, reporter), env);
      if (failure !== undefined) {
        return { ...result, sent: count - from, pending: mine.length - count, stopped: failure };
      }
      count += batch.length;
      sent[share.registry] = { otlp: share.otlp, count };
      await writeSent(sent, env);
    }
    return { ...result, sent: count - from, pending: 0 };
  });
}

/** Section 14.4: only runs from after the person agreed, whatever the bookkeeping says. */
function sendable(runs: readonly Run[], share: UsageShare): Run[] {
  const since = Date.parse(share.since);
  return runs.filter((run) => run.registry === share.registry && Date.parse(run.at) >= since);
}

/**
 * How many of `sendable` the endpoint has. Lost or for another endpoint, it starts again from the
 * first run after consent, which the endpoint counts once by its run id.
 */
function sentCount(sent: Sent, share: UsageShare, total: number): number {
  const held = sent[share.registry];
  if (held === undefined || held.otlp !== share.otlp) return 0;
  return Math.min(held.count, total);
}

async function stillShared(share: UsageShare, env: NodeJS.ProcessEnv): Promise<boolean> {
  const now = (await readConfig(env)).usage.find((item) => item.registry === share.registry);
  return now !== undefined && now.otlp === share.otlp && now.since === share.since;
}

/** The registry's usage block now; a reason to send nothing when it no longer matches consent. */
async function currentUsage(registry: SeenRegistry, share: UsageShare) {
  let identity: Awaited<ReturnType<typeof identityOf>>;
  try {
    identity = await identityOf(registry);
  } catch (error) {
    return `aireg could not read the registry: ${messageOf(error)}`;
  }
  const usage: RegistryUsage | undefined = identity?.usage;
  if (identity === undefined || usage === undefined) return "it no longer asks for usage";
  if (usage.otlp !== share.otlp) {
    return `it now sends usage to ${usage.otlp}, which you have not agreed to`;
  }
  // Finer times or names say more about a person than they agreed to share.
  if (usage.reporter !== share.reporter || usage.timePrecision !== share.precision) {
    return "it changed how runs are written since you agreed, which you have not agreed to";
  }
  return { ...identity, usage };
}

async function post(
  share: UsageShare,
  request: TraceRequest,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const response = await fetch(`${share.otlp}/v1/traces`, {
      method: "POST",
      // Protobuf, which every OTLP over HTTP receiver takes; some take no JSON.
      headers: { ...headersOf(share.alias, env), "content-type": "application/x-protobuf" },
      body: encodeTraceRequest(request),
      // Section 11: never follow the endpoint somewhere else with its headers.
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return undefined;
    return `the endpoint answered ${response.status} ${response.statusText}`.trim();
  } catch (error) {
    return `the endpoint could not be reached: ${messageOf(error)}`;
  }
}

/**
 * `AIREG_USAGE_HEADERS_<NAME>` for the registry `alias` names, as OpenTelemetry writes headers:
 * `key=value` pairs split by commas, each value percent-encoded. Read for that registry alone.
 */
export function headersOf(alias: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const raw = env[usageHeadersVariable(alias)]?.trim();
  const headers: Record<string, string> = {};
  if (raw === undefined || raw === "") return headers;
  for (const pair of raw.split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    try {
      headers[key] = decodeURIComponent(value);
    } catch {
      headers[key] = value;
    }
  }
  return headers;
}
