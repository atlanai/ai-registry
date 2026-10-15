import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAME } from "#core/product.ts";

const CHECKOUT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Every test's temp folder sits under one root per checkout, so the e2e teardown
 * can find what this run left behind without touching another checkout's tests.
 */
export const TEST_ROOT = join(
  tmpdir(),
  `${NAME}-test-${createHash("sha256").update(CHECKOUT).digest("hex").slice(0, 8)}`,
);

/**
 * Resolved, so paths compare equal to what a spawned process reports: `/private/var` on
 * macOS, and the long name of a Windows short one such as `RUNNER~1`.
 */
export function testRoot(): string {
  mkdirSync(TEST_ROOT, { recursive: true });
  return realpathSync.native(TEST_ROOT);
}

/** A fresh folder under the test root; the caller removes it. */
export async function tempDir(label = ""): Promise<string> {
  return await mkdtemp(join(testRoot(), `${NAME}-${label}`));
}
