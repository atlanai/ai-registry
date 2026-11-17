import { describe, expect, test } from "vitest";
import { scoreSkill } from "./skill.ts";

const COMPLETE = `---
name: sample-report
description: Create a weekly report from supplied metrics. Use when a user requests a weekly summary.
---
# Sample report
1. Read the supplied metrics and identify missing dates before calculating changes.
2. Compare each metric with the previous period and explain any missing comparisons.
## Output
Return a Markdown table with metric, current value, previous value, and change.
## Example
Input: two weeks of totals, 100 and 120. Output: a table showing an increase of 20 percent.
## Validation
Recompute each percentage and confirm the table covers every supplied metric exactly once.
## Failure handling
If the previous value is zero, report the percentage as undefined and explain why.
`;

describe("skill authoring signals", () => {
  test("shows evidence, provenance, and unmeasured dimensions even at full marks", () => {
    const result = scoreSkill(COMPLETE);
    expect(result.score).toBe(100);
    expect(result.checks.reduce((sum, check) => sum + check.points, 0)).toBe(100);
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.safety).toBe("not-assessed");
    expect(result.performance).toBe("not-measured");
    expect(result.review.length).toBeGreaterThan(0);
    expect(result.checks.find((check) => check.id === "output")?.evidence).toContain("line 8");
  });

  test("does not turn unavailable content into a zero-quality judgment", () => {
    expect(scoreSkill("")).toMatchObject({ status: "unavailable", score: null });
    expect(scoreSkill("x".repeat(256 * 1024 + 1))).toMatchObject({
      status: "unavailable",
      score: null,
    });
  });

  test("does not mistake headings, placeholders or code examples for substantive sections", () => {
    const result = scoreSkill(
      "# Example\nTODO: fill in a realistic example and expected output.\n# Output\n\n```md\n# Validation\nThis fabricated heading is example content and not real guidance.\n```\n<!--\n# Failure\nThis hidden text should not contribute to any authoring score.\n-->",
    );
    expect(result.checks.find((check) => check.id === "example")?.earned).toBe(0);
    expect(result.checks.find((check) => check.id === "validation")?.earned).toBe(0);
    expect(result.checks.find((check) => check.id === "recovery")?.earned).toBe(0);
  });

  test("reports invalid metadata and offers improvements without throwing", () => {
    const result = scoreSkill("---\nname: [\n---\n# Skill\nRead the input.");
    expect(result.checks.find((check) => check.id === "metadata")?.earned).toBe(0);
    expect(result.checks.find((check) => check.id === "metadata")?.improvement).toContain("YAML");
  });

  test("changes the evidence digest when the content changes and is deterministic", () => {
    expect(scoreSkill(COMPLETE)).toEqual(scoreSkill(COMPLETE));
    expect(scoreSkill(`${COMPLETE}\nNew instruction.`).digest).not.toBe(
      scoreSkill(COMPLETE).digest,
    );
  });
});
