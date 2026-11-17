import { createHash } from "node:crypto";
import { DiscoveryError, EMBEDDING_MODEL } from "./gemini.ts";

export interface Skill {
  key: string;
  name: string;
  registry: string;
  namespace: string;
  description: string;
  version: string;
  digest: string;
}
export interface Indexed {
  fingerprint: string;
  vector: number[];
}
export function description(skill: Skill): string {
  return `title: ${skill.name.slice(0, 256)} | text: ${skill.description.slice(0, 4000)}`;
}
export function fingerprint(skill: Skill): string {
  return createHash("sha256")
    .update(
      JSON.stringify([EMBEDDING_MODEL, skill.key, skill.digest, skill.version, description(skill)]),
    )
    .digest("hex");
}
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length)
    throw new DiscoveryError("The embedding dimensions changed. Rebuild the index.");
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return dot / Math.sqrt(aa * bb);
}
/** Reciprocal rank fusion avoids treating cosine similarity as a probability. */
export function retrieve(
  query: string,
  vector: number[],
  skills: Skill[],
  index: Map<string, Indexed>,
): Skill[] {
  const tokens = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const unique = [...new Map(skills.map((skill) => [skill.key, skill])).values()];
  const rows = unique.flatMap((skill) => {
    const entry = index.get(skill.key);
    if (!entry || entry.fingerprint !== fingerprint(skill)) return [];
    const words = `${skill.name} ${skill.description}`.toLowerCase();
    return [
      {
        skill,
        semantic: cosine(vector, entry.vector),
        lexical: tokens.filter((token) => words.includes(token)).length,
      },
    ];
  });
  const scores = new Map<string, number>();
  const add = (items: typeof rows) =>
    items.forEach((row, i) => {
      scores.set(row.skill.key, (scores.get(row.skill.key) ?? 0) + 1 / (60 + i + 1));
    });
  add([...rows].sort((a, b) => b.semantic - a.semantic));
  add(rows.filter((row) => row.lexical > 0).sort((a, b) => b.lexical - a.lexical));
  const seen = new Set<string>();
  return rows
    .sort((a, b) => (scores.get(b.skill.key) ?? 0) - (scores.get(a.skill.key) ?? 0))
    .map((row) => row.skill)
    .filter((skill) => {
      const identity = JSON.stringify([
        skill.registry,
        skill.namespace,
        skill.name,
        skill.version,
        skill.digest,
        description(skill),
      ]);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .slice(0, 8);
}
