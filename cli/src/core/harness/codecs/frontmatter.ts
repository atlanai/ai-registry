import { isDeepStrictEqual } from "node:util";
import { type Document, isMap, isScalar, parseDocument } from "yaml";
import { splitFrontmatter } from "#core/catalog/frontmatter.ts";
import type { ConfigValue } from "#core/harness/contract.ts";
import type { Rendered } from "./index.ts";

/** Edited as a document, so the comments and key order a person wrote survive. */
function editFrontmatter(source: string, change: (doc: Document) => string | undefined): Rendered {
  const parts = splitFrontmatter(source);
  if (parts === undefined) return { problem: "it has no front matter" };
  const doc = parseDocument(parts.yaml, { logLevel: "error" });
  if (doc.errors.length > 0 || !isMap(doc.contents)) return { problem: "it has no front matter" };
  const problem = change(doc);
  if (problem !== undefined) return { problem };
  return { text: `---\n${doc.toString()}---\n${parts.body}` };
}

/**
 * Keys the target harnesses document as limiting what an agent may use, which no codec drops
 * or changes; a definition's `restrictions` add to them.
 */
const RESTRICTIONS = ["tools", "allowed-tools", "disallowedTools", "permissionMode", "permission"];

const restricting = (own: readonly string[]) => [...RESTRICTIONS, ...own];

function keys(doc: Document): string[] {
  if (!isMap(doc.contents)) return [];
  return doc.contents.items.map((pair) => String(isScalar(pair.key) ? pair.key.value : pair.key));
}

export function frontmatterStrict(
  source: string,
  keep: readonly string[],
  restrictions: readonly string[] = [],
): Rendered {
  const limits = restricting(restrictions);
  return editFrontmatter(source, (doc) => {
    for (const key of keys(doc)) {
      if (keep.includes(key)) continue;
      // Dropped, it would let the agent do what its author ruled out.
      if (limits.includes(key)) return `it sets ${key}, which this harness cannot read`;
      doc.delete(key);
    }
    return undefined;
  });
}

export function frontmatterSet(
  source: string,
  set: Readonly<Record<string, ConfigValue>>,
  restrictions: readonly string[] = [],
): Rendered {
  const limits = restricting(restrictions);
  return editFrontmatter(source, (doc) => {
    const current = doc.toJS() as Record<string, unknown>;
    for (const [key, value] of Object.entries(set)) {
      const was = current[key];
      if (limits.includes(key) && was !== undefined && !isDeepStrictEqual(was, value)) {
        return `it sets ${key}, which this harness would change`;
      }
      doc.set(key, value);
    }
    return undefined;
  });
}
