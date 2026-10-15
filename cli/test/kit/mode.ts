import { stat } from "node:fs/promises";
import { expect } from "vitest";

/** Windows keeps no POSIX permission bits, so there the check is skipped. */
export async function expectMode(path: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  expect((await stat(path)).mode & 0o777).toBe(mode);
}
