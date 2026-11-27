import { expect, test } from "vitest";
import { mcpCodex } from "./mcp-codex.ts";

test("forwards a secret variable by name, and keeps plain values", () => {
  expect(
    mcpCodex({
      transport: "stdio",
      command: "npx",
      args: ["-y", "srv"],
      env: { URL: "https://x.test", TOKEN: [{ secret: "TOKEN" }] },
    }),
  ).toEqual({
    command: "npx",
    args: ["-y", "srv"],
    env: { URL: "https://x.test" },
    env_vars: ["TOKEN"],
  });
});

test("reads a bearer token and whole-variable headers from the environment", () => {
  expect(
    mcpCodex(
      {
        transport: "streamable-http",
        url: "https://x.test/mcp",
        headers: {
          Authorization: ["Bearer ", { secret: "T" }],
          "X-Key": [{ secret: "K" }],
          "X-Team": "core",
        },
      },
      { allow: ["a"], deny: ["b"] },
    ),
  ).toEqual({
    url: "https://x.test/mcp",
    bearer_token_env_var: "T",
    http_headers: { "X-Team": "core" },
    env_http_headers: { "X-Key": "K" },
    enabled_tools: ["a"],
  });
});

test("refuses a secret inside a larger value, or under another variable's name", () => {
  const header = { "X-Auth": ["key=", { secret: "K" }] };
  expect(mcpCodex({ transport: "streamable-http", url: "u", headers: header })).toContain("X-Auth");
  expect(
    mcpCodex({ transport: "stdio", command: "x", args: [], env: { A: [{ secret: "B" }] } }),
  ).toContain("variable A");
  expect(
    mcpCodex({ transport: "stdio", command: "x", args: [["--t=", { secret: "T" }]], env: {} }),
  ).toContain("argument");
});
