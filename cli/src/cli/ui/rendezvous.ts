import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UI_KEY_FILE } from "#core/product.ts";

/** Called under the existing launcher lease, in its private per-home directory. */
export async function launcherKey(folder: string): Promise<Buffer> {
  const path = join(folder, UI_KEY_FILE);
  try {
    await writeFile(path, randomBytes(32), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (
    !info.isFile() ||
    (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
  ) {
    throw new Error("The UI launcher key is not private.");
  }
  const key = await readFile(path);
  if (key.length !== 32) throw new Error("The UI launcher key is invalid.");
  return key;
}

export function nonce(): string {
  return randomBytes(32).toString("hex");
}

/** Distinct directions prevent reflection; the response binds the address to this connection. */
export function proof(
  key: Buffer,
  purpose: "request" | "response",
  challenge: string,
  value = "",
): string {
  return createHmac("sha256", key)
    .update(JSON.stringify([purpose, challenge, value]))
    .digest("hex");
}

export function accepts(
  key: Buffer,
  purpose: "request" | "response",
  challenge: string,
  given: unknown,
  value = "",
): boolean {
  if (
    !/^[a-f0-9]{64}$/.test(challenge) ||
    typeof given !== "string" ||
    !/^[a-f0-9]{64}$/.test(given)
  )
    return false;
  return timingSafeEqual(Buffer.from(proof(key, purpose, challenge, value)), Buffer.from(given));
}
