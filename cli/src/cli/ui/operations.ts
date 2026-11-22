import { randomBytes } from "node:crypto";
import { basename, dirname } from "node:path";
import { readRegular } from "#adapter/files.ts";
import { SKILL_ENTRY } from "#adapter/kinds.ts";
import { sanitizeText } from "#adapter/text.ts";
import type { AddResult } from "#cli/commands/add/result.ts";
import type { DoctorResult } from "#cli/commands/doctor/result.ts";
import * as commands from "#core/child/commands.ts";
import { describeCarried } from "#core/plan/carries.ts";
import { NAME } from "#core/product.ts";
import type { KeptArtifact, PageReader } from "./page-state.ts";
import type {
  UiDoctor,
  UiEvent,
  UiFile,
  UiPlan,
  UiPlanChange,
  UiRunEventBody,
  UiRunStarted,
} from "./protocol.ts";

/** Longer than an install of a large marketplace; past it, the child is stopped. */
const TIMEOUT_MS = 10 * 60_000;
/** Between SIGINT, which lets the child release its lease, and SIGKILL. */
const GRACE_MS = 10_000;
/** After SIGKILL, how long a closing server waits for the system to reap a child. */
const REAP_MS = 2_000;
const PLAN_TTL_MS = 15 * 60_000;
const MOST_PLANS = 32;
const MOST_LINES = 2_000;
const MOST_STDOUT = 8 * 1024 * 1024;
const MOST_READS = 4;

/** Refused with a sentence the page shows as is. */
export class UiError extends Error {
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

interface Captured {
  code: number;
  lines: string[];
  json: { ok?: boolean; data?: unknown; error?: { message?: string } } | undefined;
}

interface Preview {
  changes: UiPlanChange[];
  untrusted: NonNullable<AddResult["untrusted"]>;
  output: string;
}

interface Kept {
  source: string;
  select: string[];
  trustNeeded: string[];
  /** What the preview showed; apply refuses when a fresh dry run shows anything else. */
  seen: string;
  scope: AddScope;
  root: string;
  expiresAtMs: number;
}

type AddScope = Parameters<typeof commands.add>[2];

interface Child {
  running: commands.Running;
  /** Set once SIGINT is sent; SIGKILL follows unless the child exits first. */
  stopping: NodeJS.Timeout | undefined;
  exited: boolean;
}

export interface OperationsOptions {
  start?: typeof commands.start;
  graceMs?: number;
}

/** Every action the page can take: each runs as a child of this same CLI. */
export class Operations {
  readonly #reader: PageReader;
  readonly #emit: (event: UiEvent) => void;
  readonly #changed: () => void;
  readonly #start: typeof commands.start;
  readonly #graceMs: number;
  readonly #plans = new Map<string, Kept>();
  readonly #runs = new Map<string, Child>();
  /** Every child still running, runs and captures alike, so closing leaves none behind. */
  readonly #children = new Set<Child>();
  /** One write or plan at a time, as the scope's lease allows anyway. */
  #busy = false;
  #closed = false;
  #reading = 0;

  constructor(
    reader: PageReader,
    emit: (event: UiEvent) => void,
    changed: () => void,
    options: OperationsOptions = {},
  ) {
    this.#reader = reader;
    this.#emit = emit;
    this.#changed = changed;
    this.#start = options.start ?? commands.start;
    this.#graceMs = options.graceMs ?? GRACE_MS;
  }

  async plan(source: string, select: string[]): Promise<UiPlan> {
    const state = await this.#reader.read();
    const scope = state.console.scope;
    const preview = await this.#exclusive(() => this.#preview(source, select, scope, state.root));
    const planId = randomBytes(16).toString("base64url");
    this.#keep(planId, {
      source,
      select,
      trustNeeded: preview.untrusted.map((plugin) => plugin.name),
      seen: seenOf(preview),
      scope,
      root: state.root,
      expiresAtMs: Date.now() + PLAN_TTL_MS,
    });
    return {
      planId,
      source,
      changes: preview.changes,
      trustNeeded: preview.untrusted.map(({ name, carries }) => ({
        plugin: name,
        carries: carries.map((what) => describeCarried([what])),
      })),
      output: preview.output,
      command: commands.add(source, { select, trust: [], dryRun: false }, scope).display,
    };
  }

  /**
   * Only what a plan previewed, and only trust it said was needed. `aireg add` takes no pin
   * for a whole source, so a fresh dry run must show what the preview did.
   */
  async apply(planId: string, trust: string[]): Promise<UiRunStarted> {
    if (this.#busy) throw busyError();
    this.#expire();
    const kept = this.#plans.get(planId);
    if (kept === undefined) {
      throw new UiError("That plan has expired or was already used.", "Preview it again.");
    }
    const unasked = trust.filter((name) => !kept.trustNeeded.includes(name));
    if (unasked.length > 0) {
      throw new UiError(`The plan does not need trust for ${unasked.join(", ")}.`);
    }
    this.#plans.delete(planId);
    const { source, select, scope, root } = kept;
    this.#busy = true;
    try {
      await this.#reader.read(true).catch(() => undefined);
      const now = await this.#preview(source, select, scope, root);
      if (seenOf(now) !== kept.seen) {
        throw new UiError(
          "The registry changed since the preview. No files were changed.",
          "Preview again.",
        );
      }
    } finally {
      this.#busy = false;
    }
    return this.#launch(commands.add(source, { select, trust, dryRun: false }, scope), root);
  }

  async remove(key: string): Promise<UiRunStarted> {
    const artifact = await this.find(key, true);
    if (artifact.carriedBy !== undefined) {
      throw new UiError(
        `${artifact.name} comes with the plugin ${artifact.carriedBy}.`,
        `Remove ${artifact.carriedBy} to remove it.`,
      );
    }
    if (artifact.state === "available")
      throw new UiError(`${artifact.name} is not installed here.`);
    if (artifact.installedKey === undefined) {
      throw new UiError("This local folder is not managed by aireg. No files were changed.");
    }
    const state = await this.#reader.read();
    return this.#launch(commands.remove([artifact.installedKey], state.console.scope), state.root);
  }

  async sync(): Promise<UiRunStarted> {
    const state = await this.#reader.read();
    return this.#launch(commands.pullLatest(undefined, state.console.scope), state.root);
  }

  /** Read-only, so it takes no turn from the writes. */
  async doctor(): Promise<UiDoctor> {
    const ran = await this.#capture(commands.doctor(), (await this.#reader.read()).root);
    const data = ran.json?.data as DoctorResult | undefined;
    if (data === undefined) throw new UiError(`${NAME} doctor printed nothing.`);
    return {
      ok: data.problems === 0,
      checks: data.checks.map(({ name, ok, detail }) => ({ name, ok, detail })),
      output: ran.lines.join("\n"),
    };
  }

  cancel(runId: string): { cancelled: boolean } {
    const child = this.#runs.get(runId);
    if (child === undefined) return { cancelled: false };
    this.#stop(child);
    return { cancelled: true };
  }

  async find(key: string, fresh = false): Promise<KeptArtifact> {
    const state = await this.#reader.read(fresh);
    const artifact = state.artifacts.find((candidate) => candidate.key === key);
    if (artifact === undefined) throw new UiError("No artifact by that name.");
    return artifact;
  }

  /** The installed copy, read without following a link; else what its registry serves. */
  async file(key: string): Promise<UiFile> {
    const artifact = await this.find(key);
    if (artifact.copy !== "") {
      const [root, file] =
        artifact.kind === "agent"
          ? [dirname(artifact.copy), basename(artifact.copy)]
          : [artifact.copy, artifact.kind === "skill" ? SKILL_ENTRY : "README.md"];
      const read = await readRegular(root, file).catch(() => undefined);
      if (read?.kind === "file")
        return { key, text: read.bytes.toString("utf8"), from: "installed" };
    }
    // A plugin may hold no README; that is an answer, not an error.
    if (!artifact.listed) return { key, text: "", from: "installed" };
    if (this.#reading >= MOST_READS) {
      throw new UiError("Reading too many files at once.", "Try again in a moment.");
    }
    this.#reading += 1;
    const show = { display: "", argv: ["show", "--json", "--", artifact.key] };
    const ran = await this.#capture(show, (await this.#reader.read()).root).finally(() => {
      this.#reading -= 1;
    });
    const body = (ran.json?.data as { body?: unknown } | undefined)?.body;
    return { key, text: typeof body === "string" ? body : "", from: "registry" };
  }

  /**
   * Stops every child and waits for each to exit. The kill timers keep this process alive
   * meanwhile, so a child that ignores SIGINT is still killed before the server exits.
   */
  async close(): Promise<void> {
    this.#closed = true;
    const children = [...this.#children];
    for (const child of children) this.#stop(child, true);
    let bound: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      bound = setTimeout(resolve, this.#graceMs + REAP_MS);
    });
    await Promise.race([Promise.all(children.map((child) => child.running.done)), deadline]);
    clearTimeout(bound);
  }

  #launch(command: commands.Command, root: string): UiRunStarted {
    if (this.#busy) throw busyError();
    const runId = randomBytes(12).toString("base64url");
    const lines: string[] = [];
    let seq = 0;
    const event = (body: UiRunEventBody) =>
      this.#emit({ type: "run.event", runId, seq: ++seq, occurredAtMs: Date.now(), ...body });
    const child = this.#spawn(command, root, (line) => {
      const shown = sanitizeText(line, 2_000);
      if (shown === "") return;
      if (lines.length < MOST_LINES) lines.push(shown);
      event({ eventType: "run.output", data: { line: shown } });
    });
    this.#busy = true;
    this.#runs.set(runId, child);
    const timer = setTimeout(() => {
      const line = `Stopped after ${TIMEOUT_MS / 60_000} minutes.`;
      event({ eventType: "run.output", data: { line } });
      this.#stop(child);
    }, TIMEOUT_MS);
    timer.unref();
    void child.running.done.then(async (code) => {
      clearTimeout(timer);
      // Read before saying it ended, so the page's next `state.snapshot` sees what the run did.
      await this.#reader.read(true).catch(() => undefined);
      this.#runs.delete(runId);
      this.#busy = false;
      const exitCode = code < 0 ? null : code;
      const summary = lines.at(-1) ?? (code === 0 ? "Done." : `Exited with ${code}.`);
      event({ eventType: "run.finished", data: { ok: code === 0, exitCode, summary } });
      this.#changed();
    });
    return { runId, command: command.display };
  }

  async #preview(
    source: string,
    select: string[],
    scope: AddScope,
    root: string,
  ): Promise<Preview> {
    const ran = await this.#capture(commands.add(source, { select, dryRun: true }, scope), root);
    const data = ran.json?.data as AddResult | undefined;
    if (ran.json?.ok !== true || data === undefined) {
      throw new UiError(
        ran.json?.error?.message ?? ran.lines.at(-1) ?? "The dry run failed.",
        ran.lines.join("\n") || undefined,
      );
    }
    const state = await this.#reader.read();
    const known = state.artifacts.filter((artifact) => artifact.registry === data.registry);
    return {
      changes: data.installed.map((name) => {
        const artifact = known.find(
          (candidate) =>
            candidate.name === name || `${candidate.namespace}/${candidate.name}` === name,
        );
        return {
          name,
          kind: artifact?.kind ?? "",
          action: artifact === undefined || artifact.state === "available" ? "install" : "update",
          version: artifact?.version ?? "",
        };
      }),
      untrusted: data.untrusted ?? [],
      output: ran.lines.join("\n"),
    };
  }

  /** Runs to the end, keeping what it printed as data apart from what it said to a person. */
  async #capture(command: commands.Command, root: string): Promise<Captured> {
    const lines: string[] = [];
    let stdout = "";
    const child = this.#spawn(command, root, (line, stream) => {
      if (stream === "stdout") {
        if (stdout.length < MOST_STDOUT) stdout += `${line}\n`;
        return;
      }
      const shown = sanitizeText(line, 2_000);
      if (shown !== "" && lines.length < MOST_LINES) lines.push(shown);
    });
    const timer = setTimeout(() => this.#stop(child), TIMEOUT_MS);
    timer.unref();
    const code = await child.running.done.finally(() => clearTimeout(timer));
    return { code, lines, json: parsed(stdout) };
  }

  #spawn(
    command: commands.Command,
    root: string,
    onLine: (line: string, stream: commands.Stream) => void,
  ): Child {
    if (this.#closed) throw new UiError("The server is stopping.");
    const child: Child = {
      running: this.#start(command, root, onLine),
      stopping: undefined,
      exited: false,
    };
    this.#children.add(child);
    void child.running.done.then(() => {
      child.exited = true;
      clearTimeout(child.stopping);
      this.#children.delete(child);
    });
    return child;
  }

  /** SIGINT first, which lets the child release its lease; SIGKILL if it outlasts the grace. */
  #stop(child: Child, keepAlive = false): void {
    if (child.exited) return;
    if (child.stopping === undefined) {
      child.running.cancel("SIGINT");
      child.stopping = setTimeout(() => child.running.cancel("SIGKILL"), this.#graceMs);
    }
    // Unref'd while the server runs; a closing server holds on until the kill can fire.
    if (keepAlive) child.stopping.ref();
    else child.stopping.unref();
  }

  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.#busy) throw busyError();
    this.#busy = true;
    try {
      return await work();
    } finally {
      this.#busy = false;
    }
  }

  #keep(planId: string, kept: Kept): void {
    this.#expire();
    // Oldest first, as a Map iterates.
    while (this.#plans.size >= MOST_PLANS) {
      const oldest = this.#plans.keys().next().value;
      if (oldest === undefined) break;
      this.#plans.delete(oldest);
    }
    this.#plans.set(planId, kept);
  }

  #expire(): void {
    const now = Date.now();
    for (const [id, kept] of this.#plans) if (kept.expiresAtMs <= now) this.#plans.delete(id);
  }
}

/** Names, actions, versions and trust, in a stable order; the CLI's prose is left out. */
function seenOf({ changes, untrusted }: Preview): string {
  const plugins = untrusted.map(({ name, carries }) => [name, carries]);
  return JSON.stringify([changes, plugins]);
}

function busyError(): UiError {
  return new UiError("Another action is still running.", "Wait for it to finish.");
}

function parsed(text: string): Captured["json"] {
  try {
    const document: unknown = JSON.parse(text);
    return typeof document === "object" && document !== null
      ? (document as Captured["json"])
      : undefined;
  } catch {
    return undefined;
  }
}
