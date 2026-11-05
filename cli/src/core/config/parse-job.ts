import { isAbsolute } from "node:path";
import { isKind } from "#adapter/kinds.ts";
import { expandHome } from "#adapter/paths.ts";
import { quoted } from "#adapter/text.ts";
import { parseDuration, type Readers } from "#core/fields.ts";
import type { Targets } from "#core/target/contract.ts";
import { canonicalIds, earlierId } from "#core/target/ids.ts";
import { resolveTargets } from "#core/target/table.ts";
import {
  DEFAULT_INTERVAL_SECONDS,
  isBuiltinStepKind,
  isNamespaceAddress,
  isRootedStepKind,
  type Job,
  type Schedule,
  type Selector,
  STEP_FIELDS,
  STEP_POLICIES,
  type Step,
} from "./model.ts";

/** The scheduler's floor: a job run more often than this is a busy loop. */
export const MINIMUM_INTERVAL_SECONDS = 60;

/** Each id as aireg 0.1 knew it, which is what an adapter built against it reads. */
export function earlierIds(targetTable: Targets, ids: readonly string[]): string[] {
  return ids.map((id) => earlierId(targetTable, id));
}

/** One job, held to every rule config.yml is; `where` names it in a message. */
export function parseJob(value: unknown, where: string, read: Readers): Job {
  const entry = read.record(value, where);
  read.onlyKnown(entry, ["id", "name", "account", "schedule", "steps"], where);
  if (!Array.isArray(entry.steps) || entry.steps.length === 0) {
    throw read.fail(`\`${where}.steps\` must be a non-empty list.`);
  }
  const steps = entry.steps.map((item, at) => step(read, item, `${where}.steps[${at}]`));
  if (new Set(steps.map(({ name }) => name)).size !== steps.length) {
    throw read.fail(`\`${where}\` has two steps with the same name.`);
  }

  const names = new Set(steps.map(({ name }) => name));
  for (const item of steps) {
    for (const need of item.needs) {
      if (!names.has(need)) {
        throw read.fail(
          `Step ${quoted(item.name)} of \`${where}\` needs ${quoted(need)}, which the job does not have.`,
        );
      }
      if (need === item.name) {
        throw read.fail(`Step ${quoted(item.name)} of \`${where}\` needs itself.`);
      }
    }
  }

  const parsed: Job = {
    id: read.text(entry, "id", where),
    account: read.text(entry, "account", where),
    schedule: schedule(read, entry.schedule, `${where}.schedule`),
    steps,
  };
  if (entry.name !== undefined) parsed.name = read.text(entry, "name", where);
  return parsed;
}

function schedule(read: Readers, value: unknown, where: string): Schedule {
  if (value === undefined || value === null) {
    return { every: DEFAULT_INTERVAL_SECONDS, enabled: true };
  }
  const entry = read.record(value, where);
  read.onlyKnown(entry, ["every", "enabled"], where);
  return {
    every:
      entry.every === undefined
        ? DEFAULT_INTERVAL_SECONDS
        : duration(read, entry.every, `${where}.every`),
    enabled: read.optionalFlag(entry, "enabled", true, where),
  };
}

/** Seconds, or a plain duration a person would write: `900`, `15m`, `2h`. */
function duration(read: Readers, value: unknown, where: string): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < MINIMUM_INTERVAL_SECONDS) {
      throw read.fail(
        `\`${where}\` must be a whole number of at least ${MINIMUM_INTERVAL_SECONDS} seconds.`,
      );
    }
    return value;
  }
  if (typeof value !== "string") throw read.fail(`\`${where}\` must be a duration such as 15m.`);
  const ms = parseDuration(value);
  if (ms === undefined) throw read.fail(`\`${where}\` must be a duration such as 15m.`);
  const seconds = ms / 1000;
  if (seconds < MINIMUM_INTERVAL_SECONDS)
    throw read.fail(`\`${where}\` must be at least ${MINIMUM_INTERVAL_SECONDS} seconds.`);
  return seconds;
}

function step(read: Readers, value: unknown, where: string): Step {
  const entry = read.record(value, where);
  const name = read.text(entry, "name", where);
  if (name.includes("/")) throw read.fail(`\`${where}.name\` must not contain "/".`);
  const kind = read.text(entry, "kind", where);

  const extra: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(entry)) {
    if (!(STEP_FIELDS as readonly string[]).includes(key)) extra[key] = item;
  }
  // Only an adapter's own kind may carry fields aireg does not name; a
  // typo in a built-in step is a mistake, not an extension.
  if (isBuiltinStepKind(kind)) read.onlyKnown(entry, STEP_FIELDS, where);

  const parsed: Step = {
    name,
    kind,
    needs: entry.needs === undefined ? [] : read.textList(entry.needs, `${where}.needs`),
    select:
      entry.select === undefined
        ? []
        : (Array.isArray(entry.select) ? entry.select : [entry.select]).map((item, index) =>
            selector(read, item, `${where}.select[${index}]`),
          ),
    policy: read.choice(entry, "policy", STEP_POLICIES, "on", where),
    extra: Object.freeze(extra),
  };

  if (entry.root !== undefined)
    parsed.root = absolute(read, read.text(entry, "root", where), `${where}.root`);
  if (entry.to !== undefined) {
    const to = read.text(entry, "to", where);
    if (!isNamespaceAddress(to)) {
      throw read.fail(`\`${where}.to\` must be <registry>/<namespace>.`);
    }
    parsed.to = to;
  }

  if (isRootedStepKind(kind) && parsed.root === undefined) {
    throw read.fail(`\`${where}\` is a ${kind} step, so it needs a \`root\`.`);
  }
  if (kind === "origins") {
    if (parsed.to === undefined)
      throw read.fail(`\`${where}\` is an origins step, so it needs a \`to\`.`);
    if (parsed.select.length === 0) {
      throw read.fail(
        `\`${where}\` is an origins step, so it needs at least one \`select\` entry.`,
      );
    }
  }
  return parsed;
}

function selector(read: Readers, value: unknown, where: string): Selector {
  const entry = read.record(value, where);
  read.onlyKnown(entry, ["from", "match", "kinds", "target", "harness"], where);
  const selected: Selector = {
    from: absolute(read, read.text(entry, "from", where), `${where}.from`),
  };
  if (entry.match !== undefined) selected.match = read.text(entry, "match", where);
  if (entry.kinds !== undefined) {
    const kinds = read.textList(entry.kinds, `${where}.kinds`);
    for (const kind of kinds) {
      if (!isKind(kind))
        throw read.fail(`\`${where}.kinds\` names an unknown kind, ${quoted(kind)}.`);
    }
    selected.kinds = kinds.filter(isKind);
  }
  return { ...selected, ...selectedTargets(read, entry, where) };
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

/** A path a person writes by hand, so `~` is theirs to use. */
function absolute(read: Readers, value: string, where: string): string {
  const expanded = expandHome(value);
  if (!isAbsolute(expanded)) throw read.fail(`\`${where}\` must be an absolute path.`);
  return expanded;
}

/**
 * Reads `harness`, the key aireg 0.1 writes, as `target`. A job read back from the daemon
 * carries both, so both are taken when they name the same targets.
 */
function selectedTargets(
  read: Readers,
  entry: Record<string, unknown>,
  where: string,
): Pick<Selector, "target" | "harness"> {
  if (entry.target === undefined && entry.harness === undefined) return {};
  const targetTable = resolveTargets();
  const named = (key: "target" | "harness") =>
    entry[key] === undefined
      ? undefined
      : canonicalIds(targetTable, read.textList(entry[key], `${where}.${key}`));
  const target = named("target");
  const harness = named("harness");
  if (target !== undefined && harness !== undefined && !sameIds(target, harness)) {
    throw read.fail(
      `\`${where}\` names different targets under \`target\` and \`harness\`, its earlier name; keep \`target\`.`,
    );
  }
  const ids = target ?? harness ?? [];
  return { target: ids, harness: earlierIds(targetTable, ids) };
}
