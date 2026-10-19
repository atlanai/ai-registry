import type { Codec, Render } from "#core/harness/contract.ts";
import { frontmatterSet, frontmatterStrict } from "./frontmatter.ts";
import { frontmatterToml } from "./frontmatter-toml.ts";

/** The bytes a codec writes, or why it writes none. */
export type Rendered = { text: string } | { problem: string };

export function applyCodec(codec: Codec, source: string): Rendered {
  switch (codec.id) {
    case "frontmatter-toml":
      return frontmatterToml(source, codec.fields, codec.body);
    case "frontmatter-strict":
      return frontmatterStrict(source, codec.keep, codec.restrictions);
    case "frontmatter-set":
      return frontmatterSet(source, codec.set, codec.restrictions);
  }
}

/** A mapping's codec, reading the earlier `render` as the codec it became. */
export function codecOf(mapping: {
  codec?: Codec | undefined;
  render?: Render | undefined;
}): Codec | undefined {
  if (mapping.codec !== undefined) return mapping.codec;
  if (mapping.render === undefined) return undefined;
  return { id: "frontmatter-toml", fields: mapping.render.fields, body: mapping.render.body };
}
