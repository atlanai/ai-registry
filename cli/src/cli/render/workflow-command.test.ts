import { describe, expect, test } from "vitest";
import { workflowCommand } from "./workflow-command.ts";

describe("a GitHub Actions workflow command", () => {
  test("keeps a value that needs no escaping as it is", () => {
    expect(
      workflowCommand("error", { file: "artifacts/a", title: "registry" }, "is not valid."),
    ).toBe("::error file=artifacts/a,title=registry::is not valid.");
  });

  test("cannot be ended or followed by another command from inside a value", () => {
    const folder = "artifacts/x\n::warning title=INJECTED::fake,y:z%0A\r\n";
    const line = workflowCommand("error", { file: folder, title: "registry" }, `${folder} is bad`);
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toBe(
      "::error file=artifacts/x%0A%3A%3Awarning title=INJECTED%3A%3Afake%2Cy%3Az%250A%0D%0A,title=registry" +
        "::artifacts/x%0A::warning title=INJECTED::fake,y:z%250A%0D%0A is bad",
    );
  });

  test("drops terminal escapes, which the log viewer would render", () => {
    expect(workflowCommand("warning", {}, "a\u001B]0;title\u0007b\u001B[31m")).toBe(
      "::warning::ab",
    );
  });
});
