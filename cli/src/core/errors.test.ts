import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { FAILURES } from "#adapter/errors.ts";
import { ErrorCode, exitCodeFor } from "./errors.ts";

const DOCS = readFileSync(new URL("../../../docs/reference/output.md", import.meta.url), "utf8");

describe("error codes", () => {
  test.each(Object.values(ErrorCode))("documents %s with its exit status", (code) => {
    expect(DOCS).toContain(`| \`${code}\` | \`${exitCodeFor(code)}\` |`);
  });
});

describe("adapter failures", () => {
  test.each(FAILURES)("reports %s as an error code of the same name", (failure) => {
    expect(Object.values(ErrorCode)).toContain(failure);
  });
});
