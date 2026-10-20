/**
 * How a source lays out what it holds, which says how it is read: a registry by the file spec, a
 * plugin marketplace, a site's Agent Skills index, or a plain folder of skills. Not a kind, which says what one artifact is.
 */
export const LAYOUT_IDS = ["registry", "marketplace", "well-known", "folder"] as const;

/** One of `LAYOUT_IDS`. */
export type LayoutId = (typeof LAYOUT_IDS)[number];

/** Whether a string from outside, such as `--layout`, names a layout. */
export function isLayoutId(value: string): value is LayoutId {
  return (LAYOUT_IDS as readonly string[]).includes(value);
}

/** Only a registry takes publishes; aireg reads every other layout and never writes to it. */
export function isReadOnlyLayout(layout: string | undefined): boolean {
  return layout !== undefined && layout !== "registry";
}

const NOUNS: Readonly<Record<LayoutId, string>> = {
  registry: "a registry",
  marketplace: "a plugin marketplace",
  "well-known": "a site's skills index",
  folder: "a folder of skills",
};

/** What a person calls a source of this layout: `a folder of skills`. */
export function layoutNoun(layout: LayoutId): string {
  return NOUNS[layout];
}
