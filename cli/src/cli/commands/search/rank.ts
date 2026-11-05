/** What a search reads of an artifact: the fields the file spec's index carries. */
export interface Searchable {
  name: string;
  namespace: string | undefined;
  description: string | undefined;
  /** The spec's indexable string pairs, which serve as tags. */
  labels: Readonly<Record<string, string>> | undefined;
}

/** The items every word of the query matches, case-insensitively, best first. */
export function search<T extends Searchable>(items: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return items
    .flatMap((item) => {
      const at = rank(item, words);
      return at === undefined ? [] : [{ item, at }];
    })
    .sort(
      (a, b) =>
        a.at - b.at ||
        a.item.name.localeCompare(b.item.name) ||
        (a.item.namespace ?? "").localeCompare(b.item.namespace ?? ""),
    )
    .map(({ item }) => item);
}

/** Lower ranks first; undefined when a word matches nothing. */
function rank(item: Searchable, words: readonly string[]): number | undefined {
  const name = item.name.toLowerCase();
  const fields = [
    name,
    item.namespace,
    item.description,
    ...Object.entries(item.labels ?? {}).flat(),
  ].flatMap((field) => (field === undefined ? [] : [field.toLowerCase()]));
  if (!words.every((word) => fields.some((field) => field.includes(word)))) return undefined;
  // Names are hyphenated, so `pr review` means `pr-review` as much as it means two words.
  const wholes = [words.join(" "), words.join("-")];
  if (wholes.includes(name)) return 0;
  if (wholes.some((whole) => name.startsWith(whole))) return 1;
  if (wholes.some((whole) => name.includes(whole))) return 2;
  return 3;
}
