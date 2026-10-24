import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { gitEnv, transportEnv } from "./env.ts";

describe("the protocols git may use", () => {
  it("leave out plain http, so an https remote cannot redirect to it", () => {
    expect(gitEnv().GIT_ALLOW_PROTOCOL).toBe("https:ssh:file");
    expect(gitEnv(transportEnv("https://example.com/acme/kit.git")).GIT_ALLOW_PROTOCOL).toBe(
      "https:ssh:file",
    );
  });

  it("let in plain http only for a remote that is itself http, which only loopback can be", () => {
    expect(gitEnv(transportEnv("http://127.0.0.1:8080/acme/kit.git")).GIT_ALLOW_PROTOCOL).toBe(
      "https:ssh:file:http",
    );
  });
});

describe("the PATH git is found on", () => {
  it("keeps only absolute folders", () => {
    const path = ["", ".", "bin", "/usr/bin", "/bin"].join(delimiter);
    expect(gitEnv({ PATH: path }).PATH).toBe(["/usr/bin", "/bin"].join(delimiter));
  });
});
