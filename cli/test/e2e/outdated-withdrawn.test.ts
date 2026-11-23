import { join } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, fileTest as test } from "#test/kit/fixtures.ts";

let aireg: Aireg;
let market: string;

/** `review` at 0.1.0 and 0.1.1, and `lint` at 1.0.0 only; each withdrawn as the test says. */
async function publish(withdraw: { yanked?: boolean; blocked?: boolean } = {}): Promise<void> {
  const built = registry(market, { name: "acme", slug: "acme" })
    .skill("eng/review@0.1.0", { body: "review 0.1.0\n" })
    .skill("eng/review@0.1.1", { body: "review 0.1.1\n" })
    .skill("eng/lint@1.0.0", { body: "lint 1.0.0\n" });
  if (withdraw.yanked === true) built.yank("eng/review@0.1.1", "broke reviews");
  if (withdraw.blocked === true) built.block("eng/lint@1.0.0", "leaks tokens");
  await built.write();
}

test.beforeAll(async ({ aireg: run, tmp }) => {
  [aireg, market] = [run, join(tmp, "market")];
  await publish();
  expect((await aireg(["init", "-y", "--for", "claude-code"])).code).toBe(0);
  expect((await aireg(["registry", "add", market, "--as", "acme"])).code).toBe(0);
  for (const address of ["acme/eng/skill/review", "acme/eng/skill/lint"]) {
    expect((await aireg(["add", address, "-y"])).code).toBe(0);
  }
});

describe("outdated, once the registry withdraws an installed version", () => {
  test("says update rolls back a yanked version, not that everything is up to date", async () => {
    await publish({ yanked: true });
    const outdated = await aireg(["outdated"]);
    expect(outdated.code, outdated.stderr).toBe(0);
    expect(outdated.stderr).toContain(
      "Registry acme no longer serves review 0.1.1, so `aireg update` rolls it back to 0.1.0.",
    );
    expect(outdated.stdout).not.toContain("Everything is up to date.");
    const updated = await aireg(["update", "-y"]);
    expect(updated.stdout).toContain("Rolled back review 0.1.1 → 0.1.0.");
    expect((await aireg(["outdated"])).stdout).toContain("Everything is up to date.");
  });

  test("names a blocked version as blocked, not as one the registry no longer publishes", async () => {
    await publish({ yanked: true, blocked: true });
    const outdated = await aireg(["outdated"]);
    expect(outdated.code).toBe(3);
    expect(outdated.stderr).toContain(
      "eng/lint 1.0.0 is blocked (leaks tokens), and its registry serves no other version.",
    );
    expect(outdated.stderr).toContain("Run `aireg remove lint` to take it out.");
    expect(outdated.stderr).not.toContain("no longer publishes");
    const json = await aireg(["outdated", "--json"]);
    expect(JSON.parse(json.stdout).data.artifacts).toContainEqual(
      expect.objectContaining({
        name: "lint",
        unchecked: "eng/lint 1.0.0 is blocked (leaks tokens)",
      }),
    );
  });
});
