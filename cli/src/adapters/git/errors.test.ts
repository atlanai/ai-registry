import { describe, expect, test } from "vitest";
import { SpecError } from "#adapter/index.ts";
import { translating } from "./errors.ts";
import { git } from "./exec.ts";

describe("translating", () => {
  test("passes a git failure through as the adapter's own", async () => {
    const error = await git(["no-such-command"], { timeoutMs: 60_000 }).catch(
      (reason: unknown) => reason,
    );
    const translated = await translating(() => Promise.reject(error)).catch(
      (reason: unknown) => reason,
    );
    expect(translated).toBe(error);
    expect(translated).toMatchObject({ adapter: "git" });
  });

  test("reports a missing registry document as not found, with its hint", async () => {
    const missing = new SpecError("versions.json is missing.", { missing: true, hint: "Fix it." });
    await expect(translating(() => Promise.reject(missing))).rejects.toMatchObject({
      adapter: "git",
      failure: "not_found",
      hint: "Fix it.",
    });
  });
});
