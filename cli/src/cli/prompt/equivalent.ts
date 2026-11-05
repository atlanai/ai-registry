import { NAME } from "#core/product.ts";
import type { Scope } from "#core/store/paths.ts";

/** Render the equivalent non-interactive command. */
export function equivalent(
  command: string,
  source: string | undefined,
  options: {
    select?: readonly string[] | undefined;
    targets?: readonly string[] | undefined;
    scope?: Scope | undefined;
    copy?: boolean | undefined;
  },
): string {
  const parts: string[] = [NAME, command];
  if (source !== undefined) parts.push(source);
  for (const name of options.select ?? []) parts.push("-s", name);
  if (options.targets !== undefined && options.targets.length > 0) {
    parts.push("--for", [...options.targets].sort().join(","));
  }
  if (options.scope === "user") parts.push("-g");
  if (options.copy === true) parts.push("--copy");
  parts.push("-y");
  return parts.join(" ");
}
