import { assertAdapterConfig } from "#adapter/config.ts";
import type {
  PublishInput,
  PublishOptions,
  SourceAdapter,
  SourceHandle,
  UnpublishInput,
} from "#adapter/index.ts";
import type { PipelineHook } from "#core/config/hook-stages.ts";
import { configuredHooks, runPipelineHooks } from "./run.ts";

/** Wrap connect so a host that calls it itself still hits config checks and hooks. */
export function bindAdapter(adapter: SourceAdapter, alias: string): SourceAdapter {
  return {
    ...adapter,
    connect: async (context) => {
      assertAdapterConfig(adapter.id, adapter.configSchema, context.source.config);
      const hooks = await configuredHooks();
      await runPipelineHooks(
        "preConnect",
        { alias, location: context.source.location },
        context.signal,
        hooks,
      );
      const handle = await adapter.connect(context);
      try {
        await runPipelineHooks("postConnect", { alias }, context.signal, hooks);
      } catch (error) {
        // The hook's refusal is the one to report.
        await handle.close().catch(() => {});
        throw error;
      }
      return bindHandle(handle, alias, context.signal, hooks);
    },
  };
}

/** Wrap a handle so resolve/publish/unpublish/close fire the matching pipeline stages. */
function bindHandle(
  handle: SourceHandle,
  alias: string,
  signal: AbortSignal,
  hooks: readonly PipelineHook[],
): SourceHandle {
  const run = (stage: Parameters<typeof runPipelineHooks>[0], event: Record<string, unknown>) =>
    runPipelineHooks(stage, { alias, ...event }, signal, hooks);
  const { localRoot, publish, unpublish } = handle;
  const wrapped: SourceHandle = {
    resolve: async (want, options) => {
      await run("preResolve", { want });
      const resolution = await handle.resolve(want, options);
      await run("postResolve", { want });
      return resolution;
    },
    fetch: (artifact, file) => handle.fetch(artifact, file),
    close: async () => {
      try {
        await run("preClose", {});
      } finally {
        await handle.close();
      }
      await run("postClose", {});
    },
  };
  if (localRoot !== undefined) wrapped.localRoot = (artifact) => localRoot(artifact);
  // Unpublishing fires the publish stages too, so a publish gate covers removals.
  if (publish !== undefined) {
    wrapped.publish = async (changes: readonly PublishInput[], options: PublishOptions) => {
      await run("prePublish", { operation: "publish", changes, options });
      const result = await publish(changes, options);
      await run("postPublish", { operation: "publish", changes, options });
      return result;
    };
  }
  if (unpublish !== undefined) {
    wrapped.unpublish = async (changes: readonly UnpublishInput[]) => {
      await run("prePublish", { operation: "unpublish", changes });
      await unpublish(changes);
      await run("postPublish", { operation: "unpublish", changes });
    };
  }
  return wrapped;
}
