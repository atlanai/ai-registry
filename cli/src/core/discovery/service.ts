import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { deleteCredential, readCredential, saveCredential } from "#core/credentials/store.ts";
import { LeaseBusyError } from "#core/lease/errors.ts";
import { readHolder } from "#core/lease/holder.ts";
import { withLease } from "#core/lease/lease.ts";
import { leaseDir } from "#core/lease/location.ts";
import { processAlive } from "#core/process.ts";
import { DISCOVERY_OPERATION_LOCK, GEMINI_ACCOUNT_ID } from "#core/product.ts";
import { ensureHome } from "#core/store/paths.ts";
import {
  DECISION_MODEL,
  DiscoveryError,
  EMBEDDING_MODEL,
  GEMINI_ORIGIN,
  Gemini,
} from "./gemini.ts";
import { DiscoveryIndex, type IndexedSkill } from "./index.ts";
import type { DiscoveryStatus, Handoff, Job, Message, Recommendation } from "./model.ts";
import { type Receipt, Receipts } from "./receipts.ts";
import { description, fingerprint, retrieve, type Skill } from "./retrieval.ts";
import { DiscoveryStore, type UsageEvent } from "./store.ts";

/** CLI and UI share the same state and serialize writes through a per-home lease. */
export class Discovery {
  private index = new Map<string, IndexedSkill>();
  private readonly receipts: Receipts;
  private busy = false;
  private telemetryWarning = "";
  private stopping = false;
  private job: Job = { running: false, done: 0, total: 0, error: "" };
  private readonly cache: DiscoveryIndex;
  private readonly store: DiscoveryStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly send: typeof fetch;
  constructor(env: NodeJS.ProcessEnv = process.env, send: typeof fetch = fetch) {
    this.env = env;
    this.send = send;
    this.receipts = new Receipts(env);
    this.store = new DiscoveryStore(env);
    this.cache = new DiscoveryIndex(env);
  }
  private async connect(): Promise<Gemini> {
    // Read the shared credential on each operation so another process can revoke it.
    const stored = await readCredential(GEMINI_ACCOUNT_ID, this.env);
    if (stored?.origin !== GEMINI_ORIGIN || stored.credential.type !== "apiKey") {
      throw new DiscoveryError(
        "Connect your AI Studio key with `aireg discover setup` or the UI Setup tab first.",
      );
    }
    return new Gemini(stored.credential.value, this.send);
  }
  private async loadIndex(skills: Skill[]): Promise<void> {
    const { entries: cached } = await this.cache.read();
    this.index = new Map(
      skills.flatMap((skill) => {
        const entry = cached.get(fingerprint(skill));
        return entry ? [[skill.key, entry] as const] : [];
      }),
    );
  }
  async status(skills?: Skill[], available?: string[]): Promise<DiscoveryStatus> {
    const holder = await readHolder(
      leaseDir(
        { scope: "user", lock: join(ensureHome(this.env), DISCOVERY_OPERATION_LOCK) },
        this.env,
      ),
    );
    const held =
      holder !== undefined &&
      (holder.host === hostname()
        ? processAlive(holder.pid)
        : Date.now() - holder.acquiredAtMs < 10 * 60_000);
    const snapshot = await this.cache.read();
    const cached = snapshot.entries;
    const saved = await this.store.read();
    const credential = await readCredential(GEMINI_ACCOUNT_ID, this.env);
    const eligible = (skills ?? [...cached.values()].map((entry) => entry.skill)).filter((s) =>
      saved.registries.includes(s.registry),
    );
    return {
      busy: this.busy || held,
      connected: credential?.origin === GEMINI_ORIGIN && credential.credential.type === "apiKey",
      registries: saved.registries,
      telemetry: saved.telemetry,
      telemetryWarning: this.telemetryWarning,
      events: saved.events,
      available: available ?? [...new Set((skills ?? eligible).map((s) => s.registry))].sort(),
      indexReady: snapshot.complete && eligible.length > 0,
      indexedAt: snapshot.updatedAt,
      eligible: eligible.length,
      indexed: eligible.filter((s) => cached.has(fingerprint(s))).length,
      job: this.job,
      embeddingModel: EMBEDDING_MODEL,
      decisionModel: DECISION_MODEL,
    };
  }
  async setup(payload: Record<string, unknown>, available: string[]): Promise<Message> {
    return this.exclusive(async () => {
      const registries = payload.registries;
      if (
        payload.consent !== true ||
        !Array.isArray(registries) ||
        registries.length === 0 ||
        !registries.every((r) => typeof r === "string" && available.includes(r))
      ) {
        throw new DiscoveryError("Choose at least one registry and approve the Google data flow.");
      }
      let client: Gemini;
      if (typeof payload.key === "string" && payload.key.trim() !== "") {
        const key = payload.key.trim();
        if (key.length > 512 || !/^[A-Za-z0-9_-]+$/.test(key))
          throw new DiscoveryError("Enter a valid API key.");
        client = new Gemini(key, this.send);
        await client.test();
        await saveCredential(
          GEMINI_ACCOUNT_ID,
          {
            origin: GEMINI_ORIGIN,
            credential: { type: "apiKey", header: "x-goog-api-key", value: key },
          },
          this.env,
        );
      } else {
        client = await this.connect();
        await client.test();
      }
      await this.store.settings([...new Set(registries as string[])], payload.telemetry !== false);
      const previous = await this.cache.read();
      await this.loadIndex(
        [...previous.entries.values()]
          .map((entry) => entry.skill)
          .filter((s) => registries.includes(s.registry)),
      );
      await this.cache.save(this.index.values());
      await this.receipts.save([]);
      this.job = { running: false, done: 0, total: 0, error: "" };
      return { message: "Both Gemini models connected. Build your search index next." };
    });
  }
  async disconnect(): Promise<Message> {
    return this.exclusive(async () => {
      // Revoke the shared credential before unrelated storage operations.
      await deleteCredential(GEMINI_ACCOUNT_ID, this.env);
      this.index.clear();
      await this.receipts.save([]);
      await this.store.settings([], (await this.store.read()).telemetry);
      await this.cache.save([]);
      return {
        message:
          "Disconnected. The saved key and search index have been removed. Usage history is retained.",
      };
    });
  }
  async build(
    source: Skill[] | ((registries: string[]) => Promise<Skill[]>),
    background = false,
  ): Promise<Message> {
    let ready: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const task = this.exclusive(async () => {
      const saved = await this.store.read();
      const client = await this.connect();
      const skills = typeof source === "function" ? await source(saved.registries) : source;
      const eligible = skills.filter((s) => saved.registries.includes(s.registry));
      if (!eligible.length) {
        this.index.clear();
        await this.cache.save([], true);
        this.job = { running: false, done: 0, total: 0, error: "" };
        return { message: "The index is empty. Add skills to the selected sources, then refresh." };
      }
      if (eligible.length > 500)
        throw new DiscoveryError(
          "This preview supports up to 500 skills. Select fewer registries.",
        );
      await this.loadIndex(eligible);
      this.stopping = false;
      this.job = { running: true, done: 0, total: eligible.length, error: "" };
      ready?.();
      await this.indexAll(eligible, client);
      if (this.job.error) throw new DiscoveryError(this.job.error);
      return {
        message: this.stopping
          ? "Indexing stopped. Completed embeddings are saved."
          : "Search index is ready.",
      };
    });
    if (!background) return task;
    // Attach a rejection handler immediately: the UI observes subsequent failures in status.
    void task.catch((error: unknown) => {
      this.job.error = safeError(error);
    });
    return Promise.race([
      task,
      started.then(() => ({ message: "Indexing started. You can follow progress here." })),
    ]);
  }
  stop(): Message {
    this.stopping = true;
    return {
      message:
        "Indexing will stop after the current request (up to 25 seconds). Completed embeddings are kept for retry.",
    };
  }
  private async indexAll(skills: Skill[], client: Gemini): Promise<void> {
    let changed = 0;
    try {
      await this.cache.save(this.index.values(), false);
      const keep = new Set(skills.map((s) => s.key));
      for (const key of this.index.keys()) if (!keep.has(key)) this.index.delete(key);
      for (const skill of skills) {
        if (this.stopping) break;
        const hash = fingerprint(skill);
        if (this.index.get(skill.key)?.fingerprint !== hash) {
          this.index.set(skill.key, {
            skill,
            fingerprint: hash,
            vector: await client.embed(description(skill)),
          });
          changed++;
        }
        this.job.done++;
        if (changed >= 10) {
          await this.cache.save(this.index.values());
          changed = 0;
        }
      }
    } catch (error) {
      this.job.error = safeError(error);
    } finally {
      try {
        await this.cache.save(
          this.index.values(),
          !this.job.error && !this.stopping && this.job.done === this.job.total,
        );
      } catch (error) {
        this.job.error = safeError(error);
      }
      this.job.running = false;
    }
  }
  async search(payload: Record<string, unknown>): Promise<Recommendation> {
    return this.exclusive(async () => {
      const snapshot = await this.cache.read();
      const skills = [...snapshot.entries.values()].map((entry) => entry.skill);
      this.index = new Map([...snapshot.entries.values()].map((entry) => [entry.skill.key, entry]));
      const query = payload.query;
      if (typeof query !== "string" || query.trim().length < 3 || query.length > 2000) {
        throw new DiscoveryError("Describe your task in 3–2,000 characters.");
      }
      const saved = await this.store.read();
      const eligible = skills.filter((s) => saved.registries.includes(s.registry));
      if (
        !snapshot.complete ||
        !eligible.length ||
        eligible.some((s) => this.index.get(s.key)?.fingerprint !== fingerprint(s))
      ) {
        throw new DiscoveryError(
          "Build or refresh the index before searching. The saved index is missing or incomplete.",
        );
      }
      const requestId = randomUUID();
      const started = Date.now();
      try {
        const client = await this.connect();
        const queryVector = await client.embed(`task: search result | query: ${query}`);
        if ([...this.index.values()].some((entry) => entry.vector.length !== queryVector.length)) {
          await this.cache.save([]);
          this.index.clear();
          throw new DiscoveryError(
            "The embedding dimensions changed. Refresh the index before searching.",
          );
        }
        const candidates = retrieve(query, queryVector, eligible, this.index);
        const criteria: Record<string, string> = {
          none: "No candidate fits the task",
          clarify: "The task needs clarification",
        };
        candidates.forEach((s, i) => {
          criteria[`candidate_${i}`] = `${s.name}: ${s.description.slice(0, 4000)}`;
        });
        const decision = await client.decide(query, criteria);
        const selected = candidates.find((_s, i) => decision.choice === `candidate_${i}`) ?? null;
        const abstention = decision.choice === "clarify" ? "clarify" : "none";
        const result: Recommendation = {
          requestId,
          warnings: [],
          status: selected ? "recommended" : abstention,
          confidence: decision.confidence,
          candidates,
          selected,
        };
        const receipts = await this.receipts.read();
        const identity = selected
          ? {
              key: selected.key,
              name: selected.name,
              registry: selected.registry,
              namespace: selected.namespace,
              version: selected.version,
              digest: selected.digest,
            }
          : null;
        await this.receipts.save([
          ...receipts,
          {
            requestId,
            at: Date.now(),
            skill: identity,
            fingerprint: selected ? fingerprint(selected) : "",
            handedOff: false,
            feedback: false,
          },
        ]);
        await this.record({
          type: "search",
          requestId,
          durationMs: Date.now() - started,
          outcome: result.status,
        });
        if (selected)
          await this.record({
            type: "recommendation",
            requestId,
            skillKey: selected.key,
            skillVersion: selected.version,
            skillDigest: selected.digest,
            outcome: "recommended",
          });
        if (this.telemetryWarning) result.warnings.push(this.telemetryWarning);
        return result;
      } catch (error) {
        await this.record({
          type: "error",
          requestId,
          durationMs: Date.now() - started,
          outcome: "provider_or_storage_error",
        });
        throw error;
      }
    });
  }
  async handoff(
    payload: Record<string, unknown>,
    resolve: (skill: Skill) => Promise<Skill | undefined>,
  ): Promise<Handoff> {
    return this.exclusive(async () => {
      const result = await this.result(payload);
      const saved = await this.store.read();
      const skill = result.skill;
      const indexed = (await this.cache.read()).entries.get(result.fingerprint)?.skill;
      const current =
        indexed && saved.registries.includes(indexed.registry) ? await resolve(indexed) : undefined;
      if (
        !skill ||
        !saved.registries.includes(skill.registry) ||
        !current ||
        current.key !== skill.key ||
        fingerprint(current) !== result.fingerprint
      ) {
        throw new DiscoveryError(
          "This recommendation is stale. Search again before creating a handoff.",
        );
      }
      if (!result.handedOff)
        await this.record({
          type: "handoff",
          requestId: result.requestId,
          skillKey: skill.key,
          skillVersion: skill.version,
          skillDigest: skill.digest,
          outcome: "prepared",
        });
      await this.updateReceipt({ ...result, handedOff: true });
      return {
        handoff: {
          schema: "aireg.skill-handoff.v1",
          requestId: result.requestId,
          skill: {
            key: skill.key,
            name: skill.name,
            registry: skill.registry,
            namespace: skill.namespace,
            version: skill.version,
            digest: skill.digest,
          },
          instruction:
            "Verify this exact skill in your registry, inspect its instructions and permissions, then load it if appropriate. This handoff does not install or execute the skill.",
        },
      };
    });
  }
  async feedback(payload: Record<string, unknown>): Promise<Message> {
    return this.exclusive(async () => {
      const result = await this.result(payload);
      if (!result.skill || !["helpful", "not_helpful"].includes(String(payload.outcome))) {
        throw new DiscoveryError("Choose feedback for a recommended skill.");
      }
      if (!(await this.store.read()).telemetry)
        return { message: "Recording is paused; feedback was not saved." };
      if (result.feedback)
        throw new DiscoveryError("Feedback is already recorded for this recommendation.");
      await this.record({
        type: "feedback",
        requestId: result.requestId,
        skillKey: result.skill.key,
        skillVersion: result.skill.version,
        skillDigest: result.skill.digest,
        outcome: String(payload.outcome),
      });
      if (!this.telemetryWarning) await this.updateReceipt({ ...result, feedback: true });
      return {
        message:
          this.telemetryWarning ||
          "Feedback saved as user-reported feedback, not verified execution.",
      };
    });
  }
  telemetry(payload: Record<string, unknown>): Promise<Message> {
    return this.exclusive(async () => {
      if (typeof payload.enabled !== "boolean")
        throw new DiscoveryError("Choose whether to record local history.");
      const saved = await this.store.read();
      await this.store.settings(saved.registries, payload.enabled);
      this.telemetryWarning = "";
      return { message: payload.enabled ? "Local recording resumed." : "Local recording paused." };
    });
  }
  clear(): Promise<Message> {
    return this.exclusive(async () => {
      await this.store.clear();
      await this.receipts.save([]);
      return { message: "Local usage history and recommendation receipts cleared." };
    });
  }
  private async result(payload: Record<string, unknown>): Promise<Receipt> {
    const result = (await this.receipts.read()).find((r) => r.requestId === payload.requestId);
    if (!result) throw new DiscoveryError("That search has expired. Search again.");
    return result;
  }
  private async updateReceipt(receipt: Receipt): Promise<void> {
    await this.receipts.save(
      (await this.receipts.read()).map((r) => (r.requestId === receipt.requestId ? receipt : r)),
    );
  }
  private async record(
    event: Partial<UsageEvent> & Pick<UsageEvent, "type" | "requestId" | "outcome">,
  ): Promise<void> {
    try {
      await this.store.event({
        id: randomUUID(),
        at: new Date().toISOString(),
        skillKey: "",
        durationMs: 0,
        ...event,
      });
      this.telemetryWarning = "";
    } catch {
      this.telemetryWarning = "Local history could not be saved. Check storage permissions.";
    }
  }
  private async exclusive<T extends object>(work: () => Promise<T>): Promise<T> {
    if (this.busy || this.job.running)
      throw new DiscoveryError("Another discovery operation is running. Wait for it to finish.");
    this.busy = true;
    try {
      return await withLease(
        { scope: "user", lock: join(ensureHome(this.env), DISCOVERY_OPERATION_LOCK) },
        { env: this.env },
        work,
      );
    } catch (error) {
      if (error instanceof LeaseBusyError)
        throw new DiscoveryError("Another discovery operation is running. Wait for it to finish.");
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
export function safeError(error: unknown): string {
  return error instanceof DiscoveryError
    ? error.message
    : "Discovery could not complete. Check local storage permissions and try again.";
}
