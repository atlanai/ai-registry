import { isNamespace } from "#adapter/filespec/names.ts";
import type { ArtifactKind } from "#adapter/kinds.ts";
import type { PipelineHook } from "./hook-stages.ts";

export const CONFIG_SCHEMA_VERSION = 1;

/**
 * One per registry, so sign-in upserts on the alias and a job's reference survives a re-login.
 * One is signed in while `credentials.json` holds an entry under its id.
 */
export interface Account {
  id: string;
  /** Alias in the scope's `manifest.yml`, written as `registry:`. Unique across accounts. */
  registry: string;
  defaultNamespace?: string;
}

/**
 * One folder a step reads. The same shape serves every step that looks at local
 * files, so scoping is one concept rather than one per step kind.
 */
export interface Selector {
  /** A directory, or a glob when the step kind accepts one. */
  from: string;
  /** A glob over the leaf name. */
  match?: string;
  /** Absent means every kind, including kinds added later. */
  kinds?: readonly ArtifactKind[];
  /** For steps that care whose folder conventions apply. */
  target?: readonly string[];
  /** @deprecated `target` by aireg 0.1's ids, set on read for adapters built against 0.1. */
  harness?: readonly string[];
}

/** What a step does when it would change something, stored as a person types it. */
export const STEP_POLICIES = ["on", "report", "off"] as const;

export type StepPolicy = (typeof STEP_POLICIES)[number];

export function isStepPolicy(value: string): value is StepPolicy {
  return (STEP_POLICIES as readonly string[]).includes(value);
}

/**
 * Kinds aireg implements. `artifacts` is composite: it expands to `pull`,
 * `publish`, `prune` before anything runs, so the leaves are what executes.
 */
const BUILTIN_STEP_KINDS = [
  "origins",
  "artifacts",
  "pull",
  "publish",
  "prune",
  "adopt",
  "claim",
] as const;

export type BuiltinStepKind = (typeof BUILTIN_STEP_KINDS)[number];

export function isBuiltinStepKind(value: string): value is BuiltinStepKind {
  return (BUILTIN_STEP_KINDS as readonly string[]).includes(value);
}

/** Kinds aireg reconciles a scope with, once composites are expanded; the rest are an adapter's. */
const SCOPE_STEP_KINDS = [
  "origins",
  "pull",
  "publish",
  "prune",
  "adopt",
  "claim",
] as const satisfies readonly BuiltinStepKind[];

export function isScopeStep(step: Pick<Step, "kind">): boolean {
  return (SCOPE_STEP_KINDS as readonly string[]).includes(step.kind);
}

/** Kinds that reconcile a whole scope, and so need to be told which one. */
export const ROOTED_STEP_KINDS = [
  "artifacts",
  "pull",
  "publish",
  "prune",
  "adopt",
  "claim",
] as const satisfies readonly BuiltinStepKind[];

/** The leaves `artifacts` stands for, in the order their dependencies demand. */
export const COMPOSITE_STEPS: Readonly<Record<string, readonly BuiltinStepKind[]>> = Object.freeze({
  artifacts: ["pull", "publish", "prune"],
});

/** The fields aireg names; every other one on a step is its adapter's. */
export const STEP_FIELDS = [
  "name",
  "kind",
  "needs",
  "root",
  "to",
  "select",
  "policy",
] as const satisfies readonly (keyof Step)[];

/**
 * One node of a job's graph. A step names what it touches, not the job, so one
 * job can span two scopes.
 */
export interface Step {
  name: string;
  kind: string;
  /** Names of steps that must finish first. */
  needs: readonly string[];
  /** Scope root, for the kinds that reconcile a scope. */
  root?: string;
  /** `<registry>/<namespace>`, for the kinds that publish. */
  to?: string;
  select: readonly Selector[];
  policy: StepPolicy;
  /** Adapter-owned fields. Stored; aireg never names them. */
  readonly extra: Readonly<Record<string, unknown>>;
}

export interface Schedule {
  /** Seconds between runs. */
  every: number;
  /** A disabled schedule keeps the job; `aireg job start` is then the only trigger. */
  enabled: boolean;
}

/**
 * A template. A run is one execution of it, and the schema bounds a job to one
 * live run, so concurrency is not a field here.
 */
export interface Job {
  id: string;
  /** Optional label; what `aireg job start <name>` and a report show. */
  name?: string;
  /** As whom, and through the account's registry, against what. */
  account: string;
  schedule: Schedule;
  steps: readonly Step[];
}

/**
 * The namespace is the one thing onboarding cannot guess: getting it wrong
 * scatters skills across a registry under names nobody expects.
 */
export interface Defaults {
  /** `<registry>/<namespace>`, the home for artifacts this machine authors. */
  namespace?: string;
  /** What an install does with an artifact whose name another already holds. */
  nameCollision?: NameCollision;
}

/** `rename` installs it under a name from its address, `report` skips it, `fail` stops. */
const NAME_COLLISIONS = ["rename", "report", "fail"] as const;

export type NameCollision = (typeof NAME_COLLISIONS)[number];

export function isNameCollision(value: string): value is NameCollision {
  return (NAME_COLLISIONS as readonly string[]).includes(value);
}

export function nameCollisionOf(config: Pick<RegistryConfig, "defaults">): NameCollision {
  return config.defaults.nameCollision ?? "rename";
}

/** A namespace is `<registry>/<namespace>`: which registry, and whose corner of it. */
export function isNamespaceAddress(value: string): boolean {
  const parts = value.split("/");
  return parts.length === 2 && parts.every(isNamespace);
}

export interface RegistryConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  revision: number;
  /** Stops the scheduler outright; manual runs are unaffected. */
  paused: boolean;
  defaults: Defaults;
  adapters: Readonly<Record<string, string>>;
  accounts: readonly Account[];
  jobs: readonly Job[];
  /** Trusted pipeline hooks. Loaded from this file only, never from a project manifest. */
  hooks: readonly PipelineHook[];
}

export const DEFAULT_INTERVAL_SECONDS = 900;

/** The default interval as a message says it. */
export const DEFAULT_INTERVAL_WORDS = `${DEFAULT_INTERVAL_SECONDS / 60} minutes`;

export function emptyRegistryConfig(): RegistryConfig {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    revision: 0,
    paused: false,
    defaults: {},
    adapters: {},
    accounts: [],
    jobs: [],
    hooks: [],
  };
}
