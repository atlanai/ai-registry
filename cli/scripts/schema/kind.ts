import { Type } from "@sinclair/typebox";
import { KIND_SEGMENT } from "#adapter/filespec/names.ts";
import { type ArtifactKind, KINDS } from "#adapter/kinds.ts";
import { list } from "#adapter/text.ts";

/** Open, since an adapter may declare kinds beyond the built-ins. */
export const Kind = Type.Unsafe<ArtifactKind>(
  Type.String({
    pattern: KIND_SEGMENT.source,
    description: `${list(KINDS, "or")}, or a kind an adapter declares.`,
  }),
);
