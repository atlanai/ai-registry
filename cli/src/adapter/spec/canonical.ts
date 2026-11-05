import { createHash } from "node:crypto";
import type { Envelope } from "./types.ts";

/**
 * RFC 8785. Non-integer numbers are refused rather than rounded: independent
 * canonicalizers have to agree byte for byte.
 */
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
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, held]) => `${JSON.stringify(key)}:${canonicalize(held)}`).join(",")}}`;
  }
  throw new Error(`An envelope may not contain a ${typeof value}.`);
}

/** `sha256:<hex>`, the form every digest in a registry, a lock and an envelope takes. */
export function sha256(data: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

/** The one content identity. `digest` and `status` cannot sit inside it. */
export function contentDigest(envelope: Envelope): string {
  const { digest: _digest, status: _status, ...metadata } = envelope.metadata;
  return sha256(canonicalize({ ...envelope, metadata }));
}

/** Section 4.3: the content digest plus the catalog state a `versions.json` row may change. */
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

/** Digests a stream as it is read, so a large file is never held whole. */
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
