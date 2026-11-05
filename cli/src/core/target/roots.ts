import { join, resolve } from "node:path";
import type { ArtifactKind } from "#adapter/kinds.ts";
import { sanitizeName } from "#adapter/text.ts";
import type { Scope } from "#core/store/paths.ts";
import type { Target } from "./contract.ts";

/** Honors the target's own env override, which users of both tools rely on. */
export function targetRoot(
  target: Target,
  scope: Scope,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (scope !== "user") return join(cwd, target.projectRoot);
  const override = target.envHome === undefined ? undefined : env[target.envHome]?.trim();
  if (override === undefined || override === "") return target.userRoot;
  return resolve(override, target.envWithin ?? "");
}

/** Undefined when the target does not load that kind. */
export function projectionPath(
  target: Target,
  kind: ArtifactKind,
  name: string,
  scope: Scope,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const mapping = target.kinds[kind];
  // `contents` has no path of its own: the caller places what it holds.
  if (mapping === undefined || mapping.subdir === undefined) return undefined;
  if (mapping.scope !== undefined && mapping.scope !== scope) return undefined;
  // Targets discover artifacts one level deep, so a namespaced name lands flat.
  const base = name.split("/").at(-1) ?? name;
  const leaf = mapping.shape === "file" ? `${base}${mapping.extension ?? ""}` : base;
  return join(targetRoot(target, scope, cwd, env), mapping.subdir, leaf);
}

export function pluginProjection(
  target: Target,
  namespace: string,
  scope: Scope,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  source: string = namespace,
): string | undefined {
  const mapping = target.kinds.plugin;
  if (mapping?.subdir === undefined) return undefined;
  const root = targetRoot(target, scope, cwd, env);
  if (mapping.subdir.includes("{")) {
    return join(root, expandPlacement(mapping.subdir, { name: namespace, source }));
  }
  return join(root, mapping.subdir, namespace);
}

function expandPlacement(
  template: string,
  values: Readonly<{ name: string; source: string }>,
): string {
  return template.replace(/\{(source|name)\}/g, (_, key: "source" | "name") =>
    sanitizeName(values[key]),
  );
}
