import { join } from "node:path";
import { expect } from "vitest";
import { test as base } from "#test/kit/fixtures.ts";
import { serveFolder, wellKnownSite } from "#test/kit/site.ts";
import { projectTemplate } from "#test/kit/template.ts";

const test = base.extend("initialised", { scope: "file" }, ({ fileTmp }) =>
  projectTemplate(join(fileTmp, "initialised"), [["init", "--for", "claude-code"]]),
);

/**
 * Holds each registry's first request until another registry asks too, or until
 * `waitMs` passes. Reading the registries one at a time never overlaps, so the
 * second request only arrives after the first was let go.
 */
function overlapGate(prefixes: readonly string[], waitMs = 2_000) {
  let armed = false;
  let overlapped = false;
  const seen = new Set<string>();
  const waiting = new Set<string>();
  let release = () => {};
  const together = new Promise<void>((done) => {
    release = done;
  });
  return {
    arm: () => {
      armed = true;
    },
    overlapped: () => overlapped,
    before: async (path: string) => {
      const prefix = prefixes.find((candidate) => path.startsWith(candidate));
      if (!armed || prefix === undefined || seen.has(prefix)) return;
      seen.add(prefix);
      if (waiting.size > 0) {
        overlapped = true;
        release();
        return;
      }
      waiting.add(prefix);
      await Promise.race([together, new Promise((done) => setTimeout(done, waitMs))]);
      waiting.delete(prefix);
    },
  };
}

test("outdated reads its registries at the same time", async ({
  aireg,
  initialised,
  project,
  tmp,
}) => {
  const root = join(tmp, "sites");
  await wellKnownSite(join(root, "a"), [{ name: "greet" }]);
  await wellKnownSite(join(root, "b"), [{ name: "fill" }]);
  await initialised(project);
  const gate = overlapGate(["/a/", "/b/"]);
  const site = await serveFolder(root, gate.before);
  try {
    for (const path of ["a", "b"]) {
      const added = await aireg(["add", `${site.url}/${path}`, "--all"]);
      expect(added.code, added.stderr).toBe(0);
    }

    gate.arm();
    const outdated = await aireg(["outdated"]);

    expect(outdated.code, outdated.stderr).toBe(0);
    expect(gate.overlapped()).toBe(true);
  } finally {
    await site.close();
  }
});
