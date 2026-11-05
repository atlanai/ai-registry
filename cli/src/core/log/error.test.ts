import { describe, expect, test } from "vitest";
import { SpecError } from "#adapter/index.ts";
import { serializeError } from "./error.ts";

class AdapterError extends Error {
  readonly failure = "not_found";
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}

describe("serializeError", () => {
  test("keeps the stack of an error nobody classified", () => {
    expect(serializeError(new Error("unexpected")).stack).toBeDefined();
  });

  test("omits the stack of a classified error, whose code already says it", () => {
    const serialized = serializeError(new AdapterError("repository not found"));
    expect(serialized.stack).toBeUndefined();
    expect(serialized.code).toBe("not_found");
  });

  test("omits the stack of a registry that breaks the file spec, an expected failure", () => {
    expect(serializeError(new SpecError("index.json is not valid JSON.")).stack).toBeUndefined();
    expect(serializeError(new SpecError("gone", { missing: true })).code).toBe("not_found");
  });

  test("classifies any error that carries its own code, whatever its class is named", () => {
    class ScopeError extends Error {
      readonly code = "usage";
      constructor() {
        super("bad scope");
        this.name = "ScopeError";
      }
    }
    expect(serializeError(new ScopeError()).stack).toBeUndefined();
  });

  test("keeps the stack of a system error, whose code names the call that failed, not a cause", () => {
    const missing = Object.assign(new Error("ENOENT: no such file"), {
      code: "ENOENT",
      syscall: "open",
    });
    expect(serializeError(missing).stack).toBeDefined();
  });

  test("stops walking a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(() => serializeError(a)).not.toThrow();
  });

  test("describes a value that is not an Error at all", () => {
    expect(serializeError("plain string")).toMatchObject({
      name: "NonError",
      message: "plain string",
    });
  });
});
