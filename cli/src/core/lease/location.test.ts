import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { canonicalLock } from "./location.ts";

test("keys a lock whose folders will not resolve by its path, as the daemon's Windows pipe", () => {
  const native = vi.spyOn(realpathSync, "native").mockImplementation(() => {
    throw Object.assign(new Error("EINVAL: invalid argument, realpath"), { code: "EINVAL" });
  });
  try {
    expect(canonicalLock(resolve("pipe", "aireg-daemon"))).toBe(resolve("pipe", "aireg-daemon"));
  } finally {
    native.mockRestore();
  }
});
