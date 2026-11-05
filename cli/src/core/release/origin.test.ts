import { describe, expect, test } from "vitest";
import {
  adapterArtifactUrl,
  adapterManifestUrl,
  adapterVersionManifestUrl,
  artifactBaseUrl,
  artifactUrl,
} from "./origin.ts";

const PROD = "https://releases.example.com/aireg";

describe("artifact URLs", () => {
  test("refuses a version or filename that could reshape the path", () => {
    expect(artifactBaseUrl(PROD, "v0.2.0")).toBeUndefined();
    expect(artifactBaseUrl(PROD, "0.2")).toBeUndefined();
    expect(artifactUrl(PROD, "0.2.0", "../../../etc/passwd")).toBeUndefined();
    expect(artifactUrl(PROD, "0.2.0", "a/b.tgz")).toBeUndefined();
    expect(artifactUrl(PROD, "0.2.0", "")).toBeUndefined();
  });
});

describe("adapter URLs", () => {
  test("refuses an id or version that could reshape the path", () => {
    expect(adapterManifestUrl(PROD, "acme/../x", "stable")).toBeUndefined();
    expect(adapterArtifactUrl(PROD, "acme", "v1.4.0", "adapter.mjs")).toBeUndefined();
    expect(adapterVersionManifestUrl(PROD, "ACME", "1.4.0")).toBeUndefined();
  });
});
