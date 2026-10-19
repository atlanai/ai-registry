import { isLayoutId, isReadOnlyLayout, layoutNoun } from "#adapter/layouts/ids.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";

/** Said wherever aireg would publish to a source it only reads, so the advice is the same. */
const PUBLISH_ELSEWHERE =
  "Publish to a registry of your own: create one with `aireg registry init <folder>`.";

/**
 * The refusal for a registry its recorded layout makes read-only, such as a folder of skills, or
 * undefined when it is laid out as a registry. Known from the manifest, before anything connects.
 */
export function readOnlyLayout(
  alias: string,
  config: Readonly<Record<string, string>>,
): AiregError | undefined {
  const layout = config.layout;
  if (layout === undefined || !isLayoutId(layout) || !isReadOnlyLayout(layout)) return undefined;
  return new AiregError(
    `${alias} is ${layoutNoun(layout)}, not a registry, so aireg reads it but does not publish to it.`,
    { code: ErrorCode.Usage, hint: PUBLISH_ELSEWHERE },
  );
}
