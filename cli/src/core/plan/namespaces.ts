import type { SourceAdapter } from "#adapter/index.ts";
import type { LockArtifact } from "#core/lock.ts";
import { namespaceOf, type ProjectionOptions, pluginLinkAt } from "./projection.ts";

/** Whether a source's namespaces install as plugins at user scope, rather than as their parts. */
export function wrapsNamespaces(adapter: Pick<SourceAdapter, "capabilities">): boolean {
  return adapter.capabilities.namespacePlugins === true;
}

/**
 * What the lock shows a registry's namespaces installed as, for when its adapter will not load:
 * a row linked through its namespace's plugin directory was wrapped, so it stays that way.
 */
export function wrappedInLock(
  rows: readonly (readonly [string, LockArtifact])[],
  options: Pick<ProjectionOptions, "roots" | "harnesses">,
): boolean {
  return rows.some(
    ([name, row]) =>
      row.kind !== "plugin" &&
      row.links.some((link) => {
        const namespace = namespaceOf({
          kind: row.kind,
          name,
          group: row.namespace,
          source: row.registry,
        });
        return pluginLinkAt(link, namespace, row.registry, options) !== undefined;
      }),
  );
}
