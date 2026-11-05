import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAME } from "#core/product.ts";

const CHECKOUT = fileURLToPath(new URL("../..", import.meta.url));

/** One root per checkout, so e2e teardown finds this run's leftovers and no one else's. */
export const TEST_ROOT = join(
  tmpdir(),
  `${NAME}-test-${createHash("sha256").update(CHECKOUT).digest("hex").slice(0, 8)}`,
);

/** Resolved, to match what a spawned process reports: `/private/var`, or a long Windows name. */
export function testRoot(): string {
  mkdirSync(TEST_ROOT, { recursive: true });
  return realpathSync.native(TEST_ROOT);
}

/** A fresh folder under the test root; the caller removes it. */
export async function tempDir(label = ""): Promise<string> {
  return await mkdtemp(join(testRoot(), `${NAME}-${label}`));
}
