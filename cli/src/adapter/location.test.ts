import { describe, expect, test } from "vitest";
import { registryNameFromLocation } from "./location.ts";

describe("registryNameFromLocation", () => {
  test("names a registry after the last segment, as an identifier", () => {
    expect(registryNameFromLocation("https://example.com/Acme/Team_Kit.git", "git")).toBe(
      "team-kit",
    );
    expect(registryNameFromLocation("git@example.com:acme/kit.git", "git")).toBe("kit");
    expect(registryNameFromLocation("/src/Kit/", "local")).toBe("kit");
    expect(registryNameFromLocation("C:\\work\\Acme-Registry\\", "local")).toBe("acme-registry");
  });

  test("falls back to the adapter when a bare origin has no path", () => {
    expect(registryNameFromLocation("https://registry.example.com", "http")).toBe("http");
  });
});
