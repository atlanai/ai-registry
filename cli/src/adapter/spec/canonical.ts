import { createHash } from "node:crypto";
import { byCodeUnit } from "../text.ts";
import type { Envelope } from "./types.ts";

/** RFC 8785. Non-integers are refused, not rounded, so canonicalizers agree byte for byte. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`An envelope may not contain the number ${value}.`);
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    // RFC 8785 sorts keys by UTF-16 code unit.
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, held]) => held !== undefined)
      .sort(([a], [b]) => byCodeUnit(a, b));
    return `{${entries.map(([key, held]) => `${JSON.stringify(key)}:${canonicalize(held)}`).join(",")}}`;
  }
  throw new Error(`An envelope may not contain a ${typeof value}.`);
}

/** Returns `sha256:<hex>`, the form every digest takes. */
export function sha256(data: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

/** Leaves out `digest` and `status`, which cannot be part of the content identity. */
export function contentDigest(envelope: Envelope): string {
  const { digest: _digest, status: _status, ...metadata } = envelope.metadata;
  return sha256(canonicalize({ ...envelope, metadata }));
}

/** File spec section 4.3: the content digest plus the state a `versions.json` row may change. */
export function catalogDigest(
  envelope: Envelope,
  row: { status?: unknown; yanked?: unknown },
): string {
  return sha256(
    canonicalize({
      digest: contentDigest(envelope),
      status: row.status ?? null,
      yanked: row.yanked === true,
      labels: envelope.metadata.labels ?? {},
      annotations: envelope.metadata.annotations ?? {},
      relationships: envelope.relationships ?? [],
    }),
  );
}

export async function hashStream(
  source: AsyncIterable<Uint8Array>,
): Promise<{ digest: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of source) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  return { digest: `sha256:${hash.digest("hex")}`, size };
}
