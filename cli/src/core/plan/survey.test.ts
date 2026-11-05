import { describe, expect, test, vi } from "vitest";
import { LOCK_VERSION, type Lock } from "#core/lock.ts";
import { roots } from "#core/store/paths.ts";
import { survey } from "./survey.ts";

const hashing = vi.hoisted(() => ({ active: 0, peak: 0 }));

vi.mock("#core/fs/tree.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#core/fs/tree.ts")>()),
  exists: async () => true,
}));

vi.mock("#core/fs/digest.ts", () => ({
  digest: async () => {
    hashing.active += 1;
    hashing.peak = Math.max(hashing.peak, hashing.active);
    await new Promise((settle) => setTimeout(settle, 1));
    hashing.active -= 1;
    return "sha256:copy";
  },
}));

function lockOf(count: number): Lock {
  const artifacts: Lock["artifacts"] = {};
  for (let index = 0; index < count; index += 1) {
    artifacts[`skill-${index}`] = {
      registry: "kit",
      id: `skills/skill-${index}`,
      name: `skill-${index}`,
      kind: "skill",
      namespace: undefined,
      address: `skills/skill-${index}`,
      path: `skills/skill-${index}`,
      origin: undefined,
      content: "t",
      version: undefined,
      digest: "sha256:copy",
      links: [],
    };
  }
  return { version: LOCK_VERSION, registries: {}, artifacts };
}

describe("survey", () => {
  test("hashes a bounded number of installed copies at a time", async () => {
    const found = await survey(lockOf(100), roots("project", "/work"));

    expect(Object.keys(found.artifacts)).toHaveLength(100);
    expect(found.artifacts["skill-7"]?.digest).toBe("sha256:copy");
    expect(hashing.peak).toBeLessThanOrEqual(16);
  });
});
