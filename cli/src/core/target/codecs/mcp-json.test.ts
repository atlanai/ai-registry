import { expect, test } from "vitest";
import { mcpJson } from "./mcp-json.ts";

const secret = { prefix: "${", suffix: "}" };

test("writes a local server's command, and a secret as a reference to its variable", () => {
  expect(
    mcpJson(
      {
        transport: "stdio",
        command: "npx",
        args: ["-y", "srv@1.0.0", ["--token=", { secret: "TOKEN" }]],
        env: { URL: "https://x.test", KEY: [{ secret: "KEY" }] },
      },
      secret,
    ),
  ).toEqual({
    command: "npx",
    args: ["-y", "srv@1.0.0", `--token=\${TOKEN}`],
    env: { URL: "https://x.test", KEY: `\${KEY}` },
  });
});

test("writes a remote as http or sse, with its headers", () => {
  const remote = {
    url: "https://x.test/mcp",
    headers: { Authorization: ["Bearer ", { secret: "T" }] },
  } as const;
  expect(mcpJson({ transport: "streamable-http", ...remote }, secret)).toEqual({
    type: "http",
    url: "https://x.test/mcp",
    headers: { Authorization: `Bearer \${T}` },
  });
  expect(mcpJson({ transport: "sse", url: "u", headers: {} }, secret)).toEqual({
    type: "sse",
    url: "u",
  });
});
