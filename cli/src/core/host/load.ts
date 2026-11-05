import type { SourceAdapter } from "#adapter/index.ts";
import { loadAdapters } from "#core/adapter/load.ts";
import { BUILT_IN_VIEWS } from "#core/console/model.ts";
import {
  type AdapterExtension,
  type CommandContribution,
  extensionOf,
  type FlagSpec,
  type StepContribution,
} from "./extend.ts";
import type { PanelContribution, UpstreamContribution } from "./panel.ts";

export async function contributedCommands(): Promise<readonly CommandContribution[]> {
  const commands: CommandContribution[] = [];
  const seen = new Set<string>();
  for (const { extend } of await loadedExtensions()) {
    for (const command of extend.commands ?? []) {
      if (seen.has(command.name)) continue;
      seen.add(command.name);
      commands.push(command);
    }
  }
  return commands;
}

/** Every loaded adapter's extension. A broken module is skipped, not fatal. */
async function loadedExtensions(): Promise<readonly { extend: AdapterExtension }[]> {
  return (await loadAdapters()).loaded.flatMap((adapter) => {
    const extend = extensionOf(adapter);
    return extend === undefined ? [] : [{ extend }];
  });
}

export function stepOn(adapter: SourceAdapter, kind: string): StepContribution | undefined {
  return extensionOf(adapter)?.steps?.find((step) => step.kind === kind);
}

/** First adapter that registered this kind. Prefer `stepOn` the account's adapter. */
export async function stepContribution(kind: string): Promise<StepContribution | undefined> {
  for (const { extend } of await loadedExtensions()) {
    const found = (extend.steps ?? []).find((step: StepContribution) => step.kind === kind);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Step kinds whose jobs keep their interval when nothing changes. */
export async function steadyStepKinds(): Promise<ReadonlySet<string>> {
  const kinds = new Set<string>();
  for (const { extend } of await loadedExtensions()) {
    for (const step of extend.steps ?? []) if (step.steady === true) kinds.add(step.kind);
  }
  return kinds;
}

/** Selector booleans plus each kind's own options, for `parse`. */
export async function contributedStepFlags(): Promise<Readonly<Record<string, FlagSpec>>> {
  const flags: Record<string, FlagSpec> = {};
  for (const { extend } of await loadedExtensions()) {
    for (const step of extend.steps ?? []) {
      if (step.flag !== undefined && flags[step.flag] === undefined) {
        flags[step.flag] = { type: "boolean" };
      }
      for (const [name, spec] of Object.entries(step.options ?? {})) {
        if (flags[name] === undefined) flags[name] = spec as FlagSpec;
      }
    }
  }
  return flags;
}

/** `--kind` wins; otherwise the first contributed flag present on `flags`. */
export async function stepForFlags(
  flags: Readonly<Record<string, unknown>>,
): Promise<StepContribution | undefined> {
  if (typeof flags.kind === "string") return stepContribution(flags.kind);
  for (const { extend } of await loadedExtensions()) {
    for (const step of extend.steps ?? []) {
      if (step.flag !== undefined && flags[step.flag] === true) return step;
    }
  }
  return undefined;
}

/** Console tabs, in load order. A duplicate id, or one of aireg's own views, is dropped. */
// biome-ignore lint/suspicious/noExplicitAny: each panel names its own state.
export async function contributedPanels(): Promise<readonly PanelContribution<any>[]> {
  // biome-ignore lint/suspicious/noExplicitAny: each panel names its own state.
  const panels: PanelContribution<any>[] = [];
  const seen = new Set<string>(BUILT_IN_VIEWS);
  for (const { extend } of await loadedExtensions()) {
    for (const panel of extend.panels ?? []) {
      if (seen.has(panel.id)) continue;
      seen.add(panel.id);
      panels.push(panel);
    }
  }
  return panels;
}

/** First adapter that described its upstream. Only one app can own `o`. */
export async function contributedUpstream(): Promise<UpstreamContribution | undefined> {
  for (const { extend } of await loadedExtensions()) {
    if (extend.upstream !== undefined) return extend.upstream;
  }
  return undefined;
}
