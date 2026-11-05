/** How a source lays out what it holds, which decides how it is read. Not an artifact kind. */
export const LAYOUT_IDS = ["registry", "marketplace", "well-known", "folder"] as const;

export type LayoutId = (typeof LAYOUT_IDS)[number];

export function isLayoutId(value: string): value is LayoutId {
  return (LAYOUT_IDS as readonly string[]).includes(value);
}

export function isReadOnlyLayout(layout: string | undefined): boolean {
  return layout !== undefined && layout !== "registry";
}

const NOUNS: Readonly<Record<LayoutId, string>> = {
  registry: "a registry",
  marketplace: "a plugin marketplace",
  "well-known": "a site's skills index",
  folder: "a folder of skills",
};

/** For messages, such as `a folder of skills`. */
export function layoutNoun(layout: LayoutId): string {
  return NOUNS[layout];
}
