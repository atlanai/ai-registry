import { describe, expect, it } from "vitest";
import { findTarget, hostTarget } from "./targets.ts";

describe("targets", () => {
  it("resolves the host pair, and nothing else", () => {
    expect(hostTarget("darwin", "arm64")?.filename).toBe("aireg-darwin-arm64");
    expect(hostTarget("linux", "x64")?.filename).toBe("aireg-linux-amd64");
    expect(hostTarget("win32", "x64")).toMatchObject({
      bunTarget: "bun-windows-x64",
      filename: "aireg-windows-amd64.exe",
    });
    expect(hostTarget("linux", "riscv64")).toBeUndefined();
    expect(findTarget("darwin", "x64")).toBeUndefined();
  });
});
