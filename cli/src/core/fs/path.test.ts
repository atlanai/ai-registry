import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { expandUserPath, userHome } from "./path.ts";

describe("userHome", () => {
  test("takes HOME, then USERPROFILE, then what the OS reports", () => {
    expect(userHome({ HOME: "/home/u", USERPROFILE: "C:\\Users\\u" })).toBe("/home/u");
    expect(userHome({ HOME: " ", USERPROFILE: "C:\\Users\\u" })).toBe("C:\\Users\\u");
    expect(userHome({})).toBe(homedir());
  });
});

describe("expandUserPath", () => {
  test("expands ~ against HOME, and leaves anything else alone", () => {
    const env = { HOME: "/home/u" };
    expect(expandUserPath("~", env)).toBe("/home/u");
    expect(expandUserPath("~/.claude", env)).toBe(join("/home/u", ".claude"));
    expect(expandUserPath("~other/x", env)).toBe("~other/x");
    expect(expandUserPath("/opt/tool", env)).toBe("/opt/tool");
  });
});
