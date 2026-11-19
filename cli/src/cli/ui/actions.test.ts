import { describe, expect, test } from "vitest";
import * as actions from "./actions.ts";

describe("a write the browser view asks for", () => {
  test("keeps every name after `--`, so a name cannot become an option", () => {
    expect(actions.remove(["--all"], "user").argv).toEqual([
      "remove",
      "-g",
      "--yes",
      "--",
      "--all",
    ]);
    expect(actions.add("--force", { dryRun: false }, "project").argv).toEqual([
      "add",
      "--yes",
      "--",
      "--force",
    ]);
  });

  test("passes selections and trust as values, never as flags of their own", () => {
    const planned = actions.add(
      "acme-tools",
      { select: ["--all"], trust: ["deploy-kit"], dryRun: true },
      "user",
    );
    expect(planned.argv).toEqual([
      "add",
      "-g",
      "--select=--all",
      "--trust=deploy-kit",
      "--dry-run",
      "--json",
      "--",
      "acme-tools",
    ]);
    expect(planned.display).toBe(
      "aireg add -g --select=--all --trust=deploy-kit --dry-run --json -- acme-tools",
    );
  });
});
