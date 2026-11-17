import { randomUUID } from "node:crypto";
import { deleteCredential, readCredential, saveCredential } from "#core/credentials/store.ts";
import { UI_GEMINI_ACCOUNT_ID } from "#core/product.ts";
import {
  DECISION_MODEL,
  DiscoveryError,
  EMBEDDING_MODEL,
  GEMINI_ORIGIN,
  Gemini,
} from "./gemini.ts";
import { DiscoveryIndex } from "./index.ts";
import { description, fingerprint, type Indexed, retrieve, type Skill } from "./retrieval.ts";
import { DiscoveryStore, type UsageEvent } from "./store.ts";

interface Result {
  requestId: string;
  status: string;
  confidence: number | null;
  candidates: Skill[];
  selected: Skill | null;
}
interface Job {
  running: boolean;
  done: number;
  total: number;
  error: string;
}

/** One UI process owns operations; a private incremental cache survives restarts. */
export class Discovery {
  private client: Gemini | undefined;
  private index = new Map<string, Indexed>();
  private results = new Map<string, Result>();
  private busy = false;
  private telemetryWarning = "";
  private stopping = false;
  private job: Job = { running: false, done: 0, total: 0, error: "" };
  private readonly cache: DiscoveryIndex;
  private readonly handedOff = new Set<string>();
  private readonly feedbackGiven = new Set<string>();
  private readonly store: DiscoveryStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly send: typeof fetch;
  constructor(env: NodeJS.ProcessEnv = process.env, send: typeof fetch = fetch) {
    this.env = env;
    this.send = send;
    this.store = new DiscoveryStore(env);
    this.cache = new DiscoveryIndex(env);
  }
  private async connect(): Promise<Gemini> {
    if (this.client) return this.client;
    const stored = await readCredential(UI_GEMINI_ACCOUNT_ID, this.env);
    if (stored?.origin !== GEMINI_ORIGIN || stored.credential.type !== "apiKey") {
      throw new DiscoveryError("Connect your AI Studio key in Setup first.");
    }
    this.client = new Gemini(stored.credential.value, this.send);
    return this.client;
  }
  private async loadIndex(skills: Skill[]): Promise<void> {
    const cached = await this.cache.read();
    this.index = new Map(
      skills.flatMap((skill) => {
        const entry = cached.get(fingerprint(skill));
        return entry ? [[skill.key, entry] as const] : [];
      }),
    );
  }
  async status(skills: Skill[]): Promise<object> {
    const cached = await this.cache.read();
    const saved = await this.store.read();
    const credential = await readCredential(UI_GEMINI_ACCOUNT_ID, this.env);
    const eligible = skills.filter((s) => saved.registries.includes(s.registry));
    return {
      connected: credential?.origin === GEMINI_ORIGIN && credential.credential.type === "apiKey",
      registries: saved.registries,
      telemetry: saved.telemetry,
      telemetryWarning: this.telemetryWarning,
      events: saved.events,
      available: [...new Set(skills.map((s) => s.registry))].sort(),
      eligible: eligible.length,
      indexed: eligible.filter((s) => cached.has(fingerprint(s))).length,
      job: this.job,
      embeddingModel: EMBEDDING_MODEL,
      decisionModel: DECISION_MODEL,
    };
  }
  async setup(payload: Record<string, unknown>, skills: Skill[]): Promise<object> {
    return this.exclusive(async () => {
      const registries = payload.registries;
      if (
        payload.consent !== true ||
        !Array.isArray(registries) ||
        registries.length === 0 ||
        !registries.every((r) => typeof r === "string" && skills.some((s) => s.registry === r))
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
          UI_GEMINI_ACCOUNT_ID,
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
      this.client = client;
      await this.loadIndex(skills.filter((s) => registries.includes(s.registry)));
      await this.cache.save(this.index.values());
      this.results.clear();
      this.handedOff.clear();
      this.feedbackGiven.clear();
      this.job = { running: false, done: 0, total: 0, error: "" };
      return { message: "Both Gemini models connected. Build your search index next." };
    });
  }
  async disconnect(): Promise<object> {
    return this.exclusive(async () => {
      // Revoke in-memory authority first, even if a later storage operation fails.
      this.client = undefined;
      this.index.clear();
      this.results.clear();
      this.handedOff.clear();
      this.feedbackGiven.clear();
      await deleteCredential(UI_GEMINI_ACCOUNT_ID, this.env);
      await this.store.settings([], (await this.store.read()).telemetry);
      await this.cache.save([]);
      return {
        message:
          "Disconnected. The saved key and search index have been removed. Usage history is retained.",
      };
    });
  }
  async build(skills: Skill[]): Promise<object> {
    return this.exclusive(async () => {
      const saved = await this.store.read();
      const client = await this.connect();
      const eligible = skills.filter((s) => saved.registries.includes(s.registry));
      if (eligible.length === 0)
        throw new DiscoveryError(
          "No skills in the selected registries. Check the catalog and Setup.",
        );
      if (eligible.length > 500)
        throw new DiscoveryError(
          "This preview supports up to 500 skills. Select fewer registries.",
        );
      await this.loadIndex(eligible);
      this.stopping = false;
      this.job = { running: true, done: 0, total: eligible.length, error: "" };
      void this.indexAll(eligible, client);
      return { message: "Indexing started. You can follow progress here." };
    });
  }
  stop(): object {
    this.stopping = true;
    return {
      message:
        "Indexing will stop after the current request (up to 25 seconds). Completed embeddings are kept for retry.",
    };
  }
  private async indexAll(skills: Skill[], client: Gemini): Promise<void> {
    try {
      const keep = new Set(skills.map((s) => s.key));
      for (const key of this.index.keys()) if (!keep.has(key)) this.index.delete(key);
      for (const skill of skills) {
        if (this.stopping) break;
        const hash = fingerprint(skill);
        if (this.index.get(skill.key)?.fingerprint !== hash) {
          this.index.set(skill.key, {
            fingerprint: hash,
            vector: await client.embed(description(skill)),
          });
        }
        this.job.done++;
        if (this.job.done % 10 === 0) await this.cache.save(this.index.values());
      }
    } catch (error) {
      this.job.error = safeError(error);
    } finally {
      try {
        await this.cache.save(this.index.values());
      } catch (error) {
        this.job.error = safeError(error);
      }
      this.job.running = false;
    }
  }
  async search(payload: Record<string, unknown>, skills: Skill[]): Promise<object> {
    return this.exclusive(async () => {
      await this.loadIndex(skills);
      const query = payload.query;
      if (typeof query !== "string" || query.trim().length < 3 || query.length > 2000) {
        throw new DiscoveryError("Describe your task in 3–2,000 characters.");
      }
      const saved = await this.store.read();
      const eligible = skills.filter((s) => saved.registries.includes(s.registry));
      if (
        !eligible.length ||
        eligible.some((s) => this.index.get(s.key)?.fingerprint !== fingerprint(s))
      ) {
        throw new DiscoveryError(
          "Build or refresh the index before searching. The selected catalog has changed.",
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
        const result: Result = {
          requestId,
          status: selected ? "recommended" : decision.choice,
          confidence: decision.confidence,
          candidates,
          selected,
        };
        this.results.set(requestId, result);
        if (this.results.size > 100) {
          const oldest = this.results.keys().next().value ?? "";
          this.results.delete(oldest);
          this.handedOff.delete(oldest);
          this.feedbackGiven.delete(oldest);
        }
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
  async handoff(payload: Record<string, unknown>, skills: Skill[]): Promise<object> {
    return this.exclusive(async () => {
      const result = this.result(payload);
      const saved = await this.store.read();
      const skill = result.selected;
      if (
        !skill ||
        !saved.registries.includes(skill.registry) ||
        !skills.some((s) => s.key === skill.key && fingerprint(s) === fingerprint(skill))
      ) {
        throw new DiscoveryError(
          "This recommendation is stale. Search again before creating a handoff.",
        );
      }
      if (!this.handedOff.has(result.requestId))
        await this.record({
          type: "handoff",
          requestId: result.requestId,
          skillKey: skill.key,
          skillVersion: skill.version,
          skillDigest: skill.digest,
          outcome: "prepared",
        });
      this.handedOff.add(result.requestId);
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
  async feedback(payload: Record<string, unknown>): Promise<object> {
    return this.exclusive(async () => {
      const result = this.result(payload);
      if (!result.selected || !["helpful", "not_helpful"].includes(String(payload.outcome))) {
        throw new DiscoveryError("Choose feedback for a recommended skill.");
      }
      if (!(await this.store.read()).telemetry)
        return { message: "Recording is paused; feedback was not saved." };
      if (this.feedbackGiven.has(result.requestId))
        throw new DiscoveryError("Feedback is already recorded for this recommendation.");
      await this.record({
        type: "feedback",
        requestId: result.requestId,
        skillKey: result.selected.key,
        skillVersion: result.selected.version,
        skillDigest: result.selected.digest,
        outcome: String(payload.outcome),
      });
      this.feedbackGiven.add(result.requestId);
      return {
        message:
          this.telemetryWarning ||
          "Feedback saved as user-reported feedback, not verified execution.",
      };
    });
  }
  telemetry(payload: Record<string, unknown>): Promise<object> {
    return this.exclusive(async () => {
      if (typeof payload.enabled !== "boolean")
        throw new DiscoveryError("Choose whether to record local history.");
      const saved = await this.store.read();
      await this.store.settings(saved.registries, payload.enabled);
      this.telemetryWarning = "";
      return { message: payload.enabled ? "Local recording resumed." : "Local recording paused." };
    });
  }
  clear(): Promise<object> {
    return this.exclusive(async () => {
      await this.store.clear();
      return { message: "Local usage history cleared." };
    });
  }
  private result(payload: Record<string, unknown>): Result {
    const result =
      typeof payload.requestId === "string" ? this.results.get(payload.requestId) : undefined;
    if (!result) throw new DiscoveryError("That search has expired. Search again.");
    return result;
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
  private async exclusive(work: () => Promise<object>): Promise<object> {
    if (this.busy || this.job.running)
      throw new DiscoveryError("Another discovery operation is running. Wait for it to finish.");
    this.busy = true;
    try {
      return await work();
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
