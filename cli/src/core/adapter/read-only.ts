import { isLayoutId, isReadOnlyLayout, layoutNoun } from "#adapter/layouts/ids.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";

const PUBLISH_ELSEWHERE =
  "Publish to a registry of your own: create one with `aireg registry init <folder>`.";

/** From the manifest, so a read-only layout such as a folder of skills is refused before connecting. */
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
