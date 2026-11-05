import { constants } from "node:fs";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { emptyPlan } from "#test/kit/builders/plan.ts";
import { test } from "#test/kit/fixtures.ts";
import { tempDir } from "#test/kit/temp.ts";
import { blockedTargets } from "./blocked-targets.ts";
import type { Plan } from "./model.ts";

let home: string;

test.beforeEach(async ({ tmp }) => {
  home = tmp;
});

function planning(links: readonly { target: string; to: string }[]): Plan {
  return {
    ...emptyPlan(),
    actions: links.map(({ target, to }) => ({
      kind: "link" as const,
      name: "lint",
      target,
      from: join(home, "from"),
      to,
      copy: false,
    })),
  };
}

/** Root or CAP_DAC_OVERRIDE ignores mode bits; probed, since the uid misses the capability. */
const modesIgnored = await (async () => {
  const probe = await tempDir("modes-");
  try {
    await chmod(probe, 0o555);
    await access(probe, constants.W_OK);
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
})();

describe("blockedTargets", () => {
  test.skipIf(modesIgnored)("names a target whose root cannot be written into", async () => {
    const root = join(home, ".cursor");
    await mkdir(root);
    await chmod(root, 0o555);

    const blocked = await blockedTargets(
      planning([{ target: "cursor", to: join(root, "skills", "lint") }]),
    );

    expect(blocked).toEqual([{ target: "cursor", path: root }]);
  });

  test("is empty when the parents do not exist yet under a writable directory", async () => {
    // The ordinary case: ~/.pi/agent/skills is created by the apply, and its
    // absence must not read as a problem.
    const blocked = await blockedTargets(
      planning([{ target: "pi", to: join(home, ".pi", "agent", "skills", "lint") }]),
    );

    expect(blocked).toEqual([]);
  });

  test("names a target whose root is a file, which no directory can be made in", async () => {
    const root = join(home, ".cursor");
    await writeFile(root, "not a directory\n");

    const blocked = await blockedTargets(
      planning([{ target: "cursor", to: join(root, "skills", "lint") }]),
    );

    expect(blocked).toEqual([{ target: "cursor", path: root }]);
  });

  test.skipIf(modesIgnored)("checks a target once, however many artifacts it takes", async () => {
    const root = join(home, ".cursor");
    await mkdir(root);
    await chmod(root, 0o555);

    const blocked = await blockedTargets(
      planning([
        { target: "cursor", to: join(root, "skills", "lint") },
        { target: "cursor", to: join(root, "skills", "review") },
      ]),
    );

    expect(blocked).toHaveLength(1);
  });
});
