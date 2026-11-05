import { isDeepStrictEqual } from "node:util";
import {
  type Document,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";
import { isRecord } from "#adapter/fields.ts";
import { FORMAT, formatManifest, inEarlierNames, manifestData } from "./format.ts";
import { LEGACY_TARGETS_KEY, type Manifest } from "./model.ts";

const keyOf = (key: unknown): string => String(isScalar(key) ? key.value : key);

/** Edited in place, so a person's comments and blank lines survive. */
export function editManifest(text: string, manifest: Manifest): string {
  const doc: Document = parseDocument(text);
  if (doc.errors.length > 0) return formatManifest(manifest);
  const current = saysTargets(doc);
  if (current) renameLegacyKeys(doc);
  separateSections(doc);
  const data = manifestData(manifest);
  doc.contents = merged(
    doc,
    doc.contents,
    current ? data : inEarlierNames(data),
  ) as Document["contents"];
  const first = isMap(doc.contents) ? doc.contents.items[0]?.key : undefined;
  if (isNode(first)) first.spaceBefore = false;
  return doc.toString(FORMAT);
}

/** Someone opted in to `targets:` by writing it; any other manifest keeps the names 0.1 reads. */
function saysTargets(doc: Document): boolean {
  return targetMaps(doc).some((map) => map.has("targets"));
}

/** The mappings that can hold a target list: the root, and each artifact entry. */
function targetMaps(doc: Document): YAMLMap[] {
  const maps: unknown[] = [doc.contents];
  const artifacts = isMap(doc.contents) ? doc.contents.get("artifacts") : undefined;
  if (isSeq(artifacts)) maps.push(...artifacts.items);
  return maps.filter((map): map is YAMLMap => isMap(map));
}

// A comment paragraph belongs to the key right below it, and the parser hands every
// paragraph between two top-level keys to the first; these split them back apart.
const paragraphs = (comment: string | null | undefined): string[] =>
  comment === null || comment === undefined || comment === "" ? [] : comment.split("\n\n");

/** `harnesses:` renamed where it stands, so its comments move with it. */
function renameLegacyKeys(doc: Document): void {
  for (const map of targetMaps(doc)) {
    const pair = map.items.find((item) => keyOf(item.key) === LEGACY_TARGETS_KEY);
    if (pair !== undefined && isScalar(pair.key)) pair.key.value = "targets";
  }
}

/** The paragraphs trailing a section that a blank line set apart, moved to the key below. */
function separateSections(doc: Document): void {
  if (!isMap(doc.contents)) return;
  const pairs = doc.contents.items;
  for (const [index, pair] of pairs.entries()) {
    const next = pairs[index + 1];
    if (!isNode(pair.value) || !isNode(next?.key)) continue;
    const [own, ...rest] = paragraphs(pair.value.comment);
    if (rest.length === 0) continue;
    pair.value.comment = own ?? null;
    next.key.commentBefore = joined(...rest, next.key.commentBefore);
    next.key.spaceBefore = true;
  }
}

function joined(...comments: (string | null | undefined)[]): string | null {
  const all = comments.flatMap(paragraphs);
  return all.length === 0 ? null : all.join("\n\n");
}

/** Changes only what differs, so a node keeps its comments. */
function merged(doc: Document, node: unknown, value: unknown): unknown {
  if (isNode(node) && isDeepStrictEqual(node.toJS(doc), value)) return node;
  if (isMap(node) && isRecord(value)) {
    return mergedMap(doc, node, value as Record<string, unknown>);
  }
  if (isSeq(node) && Array.isArray(value)) return mergedSeq(doc, node, value);
  if (isScalar(node) && (typeof value !== "object" || value === null)) {
    node.value = value;
    return node;
  }
  const created = doc.createNode(value);
  if (isNode(node)) {
    created.commentBefore = node.commentBefore ?? null;
    created.comment = node.comment ?? null;
  }
  return created;
}

function mergedMap(doc: Document, node: YAMLMap, value: Record<string, unknown>): YAMLMap {
  const keys = Object.keys(value);
  // An empty `{}` that gains entries becomes a block; one written inline with entries stays inline.
  if (node.items.length === 0 && keys.length > 0) node.flow = false;
  const kept: typeof node.items = [];
  let carried: string | null = null;
  for (const pair of node.items) {
    if (!keys.includes(keyOf(pair.key))) {
      carried = joined(carried, leading(pair.key));
      continue;
    }
    if (carried !== null && isNode(pair.key)) {
      pair.key.commentBefore = joined(carried, pair.key.commentBefore);
      carried = null;
    }
    kept.push(pair);
  }
  node.items = kept;
  for (const [index, key] of keys.entries()) {
    const pair = node.items.find((item) => keyOf(item.key) === key);
    if (pair !== undefined) {
      pair.value = merged(doc, pair.value, value[key]);
      continue;
    }
    const later = keys.slice(index + 1);
    const at = node.items.findIndex((item) => later.includes(keyOf(item.key)));
    node.items.splice(at === -1 ? node.items.length : at, 0, doc.createPair(key, value[key]));
  }
  return node;
}

/** What sits above a deleted key that is not about the key: a file's heading, say. */
function leading(key: unknown): string | null {
  return isNode(key) ? joined(...paragraphs(key.commentBefore).slice(0, -1)) : null;
}

/** Entries match by value; one edited in place keeps its slot's comment. */
function mergedSeq(doc: Document, node: YAMLSeq, value: readonly unknown[]): YAMLSeq {
  const before = node.items;
  const taken = new Set<number>();
  const same = value.map((item) => {
    const at = before.findIndex(
      (existing, index) =>
        !taken.has(index) && isNode(existing) && isDeepStrictEqual(existing.toJS(doc), item),
    );
    if (at !== -1) taken.add(at);
    return at;
  });
  if (before.length === 0 && value.length > 0) node.flow = false;
  node.items = value.map((item, index) => {
    const at = same[index] ?? -1;
    if (at !== -1) return before[at];
    if (index < before.length && !taken.has(index)) {
      taken.add(index);
      return merged(doc, before[index], item);
    }
    return doc.createNode(item);
  });
  return node;
}
