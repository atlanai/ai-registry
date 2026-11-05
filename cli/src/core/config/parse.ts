import { stringify } from "yaml";
import { quoted } from "#adapter/text.ts";
import { isRecord } from "#core/fields.ts";
import { isAdapterId } from "#core/release/origin.ts";
import type { Targets } from "#core/target/contract.ts";
import { resolveTargets } from "#core/target/table.ts";
import { parseYaml } from "#core/yaml.ts";
import { ConfigConflictError, ConfigError, fields } from "./errors.ts";
import { isHookStage, type PipelineHook } from "./hook-stages.ts";
import {
  CONFIG_SCHEMA_VERSION,
  type Defaults,
  isNameCollision,
  isNamespaceAddress,
  type RegistryConfig,
  type Selector,
  type Step,
} from "./model.ts";
import { parseAccount } from "./parse-account.ts";
import { earlierIds, parseJob } from "./parse-job.ts";

const { onlyKnown, optionalFlag, record, text } = fields;

export function parseConfig(contents: string, filename = "config.yml"): RegistryConfig {
  let document: unknown;
  try {
    document = parseYaml(contents);
  } catch (cause) {
    const first = (cause as Error).message.split("\n")[0]?.replace(/:$/, "");
    throw new ConfigError(`${filename} is not valid YAML: ${first}.`);
  }
  try {
    return parseDocument(document);
  } catch (error) {
    // Each check names a field; only here is the file it came from known.
    if (!(error instanceof ConfigError) || error instanceof ConfigConflictError) throw error;
    throw new ConfigError(`${filename}: ${error.message}`, error.code);
  }
}

function parseDocument(document: unknown): RegistryConfig {
  if (!isRecord(document)) throw new ConfigError("The file must be a mapping at the top level.");
  const root = document;
  onlyKnown(
    root,
    ["schemaVersion", "revision", "paused", "defaults", "adapters", "accounts", "jobs", "hooks"],
    "",
  );
  if (root.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(`\`schemaVersion\` must be ${CONFIG_SCHEMA_VERSION}.`);
  }
  if (!Number.isInteger(root.revision) || (root.revision as number) < 0) {
    throw new ConfigError("`revision` must be a whole number of 0 or more.");
  }
  if (!Array.isArray(root.accounts) || !Array.isArray(root.jobs)) {
    throw new ConfigError("`accounts` and `jobs` must be lists.");
  }
  const accounts = root.accounts.map(parseAccount);
  const jobs = root.jobs.map((item, index) => parseJob(item, `jobs[${index}]`, fields));
  unique(
    accounts.map(({ id }) => id),
    "Two accounts have the same id.",
  );
  unique(
    accounts.map(({ registry }) => registry),
    "Two accounts are for the same registry.",
  );
  unique(
    jobs.map(({ id }) => id),
    "Two jobs have the same id.",
  );
  const hooks = parseHooks(root.hooks);
  unique(
    hooks.map(({ id }) => id),
    "Two hooks have the same id.",
  );
  const accountIds = new Set(accounts.map(({ id }) => id));
  const dangling = jobs.find(({ account: id }) => !accountIds.has(id));
  if (dangling !== undefined)
    throw new ConfigError(`Job ${quoted(dangling.id)} names an unknown account.`);

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    revision: root.revision as number,
    paused: optionalFlag(root, "paused", false),
    defaults: defaults(root.defaults, "defaults"),
    adapters: adapterPins(root.adapters),
    accounts,
    jobs,
    hooks,
  };
}

function defaults(value: unknown, where: string): Defaults {
  if (value === undefined || value === null) return {};
  const entry = record(value, where);
  onlyKnown(entry, ["namespace", "nameCollision"], where);
  const result: Defaults = {};
  if (entry.namespace !== undefined) {
    const namespace = text(entry, "namespace", where);
    if (!isNamespaceAddress(namespace)) {
      throw new ConfigError(`\`${where}.namespace\` must be <registry>/<namespace>.`);
    }
    result.namespace = namespace;
  }
  if (entry.nameCollision !== undefined) {
    const policy = text(entry, "nameCollision", where);
    if (!isNameCollision(policy)) {
      throw new ConfigError(`\`${where}.nameCollision\` must be rename, report or fail.`);
    }
    result.nameCollision = policy;
  }
  return result;
}

function unique(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) throw new ConfigError(message);
}

function parseHooks(value: unknown): PipelineHook[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError("`hooks` must be a list.");
  return value.map((item, index) => {
    const where = `hooks[${index}]`;
    const entry = record(item, where);
    onlyKnown(entry, ["id", "stage", "handler", "matcher"], where);
    const stage = text(entry, "stage", where);
    if (!isHookStage(stage)) {
      throw new ConfigError(`\`${where}.stage\` names an unknown stage, ${quoted(stage)}.`);
    }
    return {
      id: text(entry, "id", where),
      stage,
      handler: text(entry, "handler", where),
      ...(entry.matcher === undefined ? {} : { matcher: text(entry, "matcher", where) }),
    };
  });
}

/** Each pin maps an adapter id to the module config.yml loads for it. */
function adapterPins(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  const entries = Object.entries(record(value, "adapters"));
  const misnamed = entries.find(([id]) => !isAdapterId(id));
  if (misnamed !== undefined) {
    throw new ConfigError(`\`adapters\` names ${quoted(misnamed[0])}, which is not an adapter id.`);
  }
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new ConfigError("`adapters` must map each adapter id to a module path.");
  }
  const result: Record<string, string> = {};
  for (const [key, item] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    result[key] = item as string;
  }
  return Object.freeze(result);
}

export function formatConfig(config: RegistryConfig): string {
  const targetTable = resolveTargets();
  const document = {
    ...config,
    accounts: config.accounts.map(({ id, registry, ...rest }) => ({
      id,
      registry,
      ...rest,
    })),
    jobs: config.jobs.map((job) => ({
      id: job.id,
      ...(job.name === undefined ? {} : { name: job.name }),
      account: job.account,
      schedule: { every: job.schedule.every, enabled: job.schedule.enabled },
      steps: job.steps.map((step) => written(step, targetTable)),
    })),
  };
  return stringify(document, { indent: 2, defaultStringType: "PLAIN", lineWidth: 0 });
}

/** Steps carry an `extra` bag aireg never names; it is spread back out. */
function written(step: Step, targetTable: Targets): Record<string, unknown> {
  const { extra, ...rest } = step;
  const entry: Record<string, unknown> = { name: rest.name, kind: rest.kind };
  if (rest.needs.length > 0) entry.needs = [...rest.needs];
  if (rest.root !== undefined) entry.root = rest.root;
  if (rest.to !== undefined) entry.to = rest.to;
  if (rest.select.length > 0) {
    entry.select = rest.select.map((item) => writtenSelector(item, targetTable));
  }
  if (rest.policy !== "on") entry.policy = rest.policy;
  return { ...entry, ...extra };
}

/** Targets under `harness`, by their 0.1 ids: an adapter built against 0.1 reads only those. */
function writtenSelector(
  { target, harness: _, ...rest }: Selector,
  targetTable: Targets,
): Record<string, unknown> {
  return target === undefined ? { ...rest } : { ...rest, harness: earlierIds(targetTable, target) };
}
