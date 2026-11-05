import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { callingAgent, SIGNALS } from "#cli/prompt/caller.ts";
import { isCI } from "#core/env.ts";
import { TELEMETRY_ID_FILE } from "#core/product.ts";
import { ensureHome } from "#core/store/paths.ts";
import { VERSION } from "#core/version.ts";
import { GITHUB_SLUG, NAMING_FIELDS, type Queued } from "./model.ts";
import { savedTelemetryState } from "./state.ts";

/** Each request the background sender makes, and the sender as a whole, give up after these. */
const REQUEST_TIMEOUT_MS = 3000;
const SENDER_TIMEOUT_MS = 10_000;

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
    const response = await $fetch(state.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(await payloadOf(fields, env)),
      redirect: "error",
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

async function payloadOf(
  fields: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  const payload: Record<string, string> = {
    event: String(fields.event),
    v: VERSION,
    os: process.platform,
    arch: process.arch,
  };
  if (isCI(env)) payload.ci = "1";
  const agent = agentOf(env);
  if (agent !== undefined) payload.agent = agent;
  const id = await installId(env);
  if (id !== undefined) payload.id = id;
  for (const [key, value] of Object.entries(fields)) {
    if (key !== "event" && typeof value === "string") payload[key] = value;
  }
  return payload;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

const GITHUB_API = "https://api.github.com";
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
