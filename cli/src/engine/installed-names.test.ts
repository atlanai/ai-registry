import { describe, expect, test } from "vitest";
import { lock } from "#test/kit/builders/lock.ts";
import { matchInstalled, rowsNamed, shownNames } from "./installed-names.ts";

const row = (registry: string, namespace: string, name: string) => ({
  registry,
  namespace,
  version: "1.0.0",
  path: `.registry/artifacts/${registry}/${namespace}/skills/${name}`,
  digest: "",
});

describe("installed names", () => {
  const scope = lock()
    .artifact("personal/pr-review", row("mine", "personal", "pr-review"))
    .artifact("lint", row("acme", "eng", "lint"))
    .artifact("frontend/lint", row("acme", "frontend", "lint"))
    .build();

  test("shows the shortest name no other artifact shares", () => {
    const shown = shownNames(scope);
    expect(shown.get("personal/pr-review")).toBe("pr-review");
    expect(shown.get("lint")).toBe("eng/lint");
    expect(shown.get("frontend/lint")).toBe("frontend/lint");
  });

  test("takes any longer form of a name", () => {
    expect(rowsNamed("pr-review", scope)).toEqual(["personal/pr-review"]);
    expect(rowsNamed("personal/skill/pr-review", scope)).toEqual(["personal/pr-review"]);
    expect(rowsNamed("acme/frontend/skill/lint", scope)).toEqual(["frontend/lint"]);
  });

  test("refuses a name two artifacts share, and names both", () => {
    expect(() => rowsNamed("lint", scope)).toThrow(
      '"lint" matches 2 installed artifacts: acme/eng/skill/lint and acme/frontend/skill/lint.',
    );
    expect(matchInstalled("acme", scope)).toEqual({ rows: ["lint", "frontend/lint"], whole: true });
    expect(() => rowsNamed("nope", scope)).toThrow('No installed artifact named "nope".');
  });
});
