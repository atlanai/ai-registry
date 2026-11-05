import { describe, expect, test } from "vitest";
import { releaseBinary } from "./product.ts";

describe("releaseBinary", () => {
  test("names the download after the platform", () => {
    expect(releaseBinary("darwin-arm64")).toBe("aireg-darwin-arm64");
    expect(releaseBinary("windows-arm64")).toBe("aireg-windows-arm64.exe");
  });
});
