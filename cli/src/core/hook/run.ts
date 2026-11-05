import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { messageOf } from "#adapter/errors.ts";
import { AdapterError } from "#adapter/index.ts";
import { assertWithin } from "#adapter/paths.ts";
import type { HookEvent, HookStage, PipelineHook } from "#core/config/hook-stages.ts";
import { readConfig } from "#core/config/repository.ts";
import { toolHome } from "#core/store/paths.ts";

/** User hooks from `~/.aireg/config.yml` only. Never from a project manifest. */
export async function configuredHooks(): Promise<readonly PipelineHook[]> {
  return (await readConfig()).hooks;
}

/** `given` is the hook list read once per connection. */
export async function runPipelineHooks(
  stage: HookStage,
  event: Omit<HookEvent, "stage"> = {},
  signal?: AbortSignal,
  given?: readonly PipelineHook[],
): Promise<void> {
  signal?.throwIfAborted();
  const home = toolHome();
  const hooks = given ?? (await configuredHooks());
  if (hooks.length === 0) return;
  const full: HookEvent = signal === undefined ? { ...event, stage } : { ...event, stage, signal };
  for (const hook of hooks) {
    signal?.throwIfAborted();
    if (!matches(hook, full)) continue;
    await invoke(hook, full, home);
  }
}

function matches(hook: PipelineHook, event: HookEvent): boolean {
  if (hook.stage !== event.stage) return false;
  if (hook.matcher === undefined) return true;
  if (event.alias === hook.matcher) return true;
  return event.aliases?.includes(hook.matcher) === true;
}

async function invoke(hook: PipelineHook, event: HookEvent, home: string): Promise<void> {
  try {
    const handler = await loadHandler(hook, home);
    await handler(event);
  } catch (cause) {
    if (cause instanceof AdapterError) throw cause;
    const message = messageOf(cause);
    throw new AdapterError("hooks", "invalid", `${hook.id} rejected ${event.stage}: ${message}`, {
      cause,
      problem: {
        code: "HOOK_REJECTED",
        title: `${hook.id} rejected ${event.stage}: ${message}`,
      },
    });
  }
}

async function loadHandler(
  hook: PipelineHook,
  home: string,
): Promise<(event: HookEvent) => unknown> {
  const url = pathToFileURL(handlerFile(hook.handler, home)).href;
  const module = (await import(url)) as Record<string, unknown>;
  const candidate = module.default ?? module.handler;
  if (typeof candidate !== "function") {
    throw new AdapterError("hooks", "invalid", `${hook.id} exported no handler.`, {
      problem: { code: "HOOK_REJECTED", title: `${hook.id} exported no handler.` },
    });
  }
  return candidate as (event: HookEvent) => unknown;
}

function handlerFile(handler: string, home: string): string {
  const resolved = isAbsolute(handler) ? handler : join(home, handler);
  assertWithin(home, resolved, "hook handler");
  return resolved;
}
