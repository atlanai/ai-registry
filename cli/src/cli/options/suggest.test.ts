import { describe, expect, test } from "vitest";
import { ErrorCode } from "#core/errors.ts";
import { closest, unknownAction } from "./suggest.ts";

const COMMANDS = ["init", "add", "remove", "install", "i", "status", "list"];

describe("closest", () => {
  test("suggests the command one typo away", () => {
    expect(closest("instal", COMMANDS)).toBe("install");
    expect(closest("ad", COMMANDS)).toBe("add");
    expect(closest("stauts", COMMANDS)).toBe("status");
  });

  test("suggests nothing for a short or distant word", () => {
    expect(closest("x", ["i"])).toBeUndefined();
    expect(closest("frobnicate", COMMANDS)).toBeUndefined();
  });
});

describe("unknownAction", () => {
  test("is a usage error led by the guess", () => {
    const error = unknownAction("registry", "ad", ["add", "list"], "Use add or list.");
    expect(error.code).toBe(ErrorCode.Usage);
    expect(error.message).toBe('Unknown registry action "ad".');
    expect(error.hint).toBe("Did you mean `aireg registry add`? Use add or list.");
  });
});
