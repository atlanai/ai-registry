import { expect, test } from "vitest";
import type { McpEntry } from "#core/mcp/model.ts";
import type { McpJsonCodec } from "#core/target/contract.ts";
import { mcpJson } from "./mcp-json.ts";

const claude: McpJsonCodec = {
  id: "mcp-json",
  secret: { prefix: "${", suffix: "}" },
  type: { "streamable-http": "http", sse: "sse" },
};

const local: McpEntry = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "srv@1.0.0", ["--token=", { secret: "TOKEN" }]],
  env: { URL: "https://x.test", KEY: [{ secret: "KEY" }] },
};

const remote: McpEntry = {
  transport: "streamable-http",
  url: "https://x.test/mcp",
  headers: { Authorization: ["Bearer ", { secret: "T" }] },
};

test("writes a local server's command, and a secret as a reference to its variable", () => {
  expect(mcpJson(local, claude)).toEqual({
    command: "npx",
    args: ["-y", "srv@1.0.0", `--token=\${TOKEN}`],
    env: { URL: "https://x.test", KEY: `\${KEY}` },
  });
});

test("writes a remote as http or sse, with its headers", () => {
  expect(mcpJson(remote, claude)).toEqual({
    type: "http",
    url: "https://x.test/mcp",
    headers: { Authorization: `Bearer \${T}` },
  });
  expect(mcpJson({ transport: "sse", url: "u", headers: {} }, claude)).toEqual({
    type: "sse",
    url: "u",
  });
});

test("names the type, URL, command and environment keys as the target does", () => {
  const codec: McpJsonCodec = {
    id: "mcp-json",
    secret: { prefix: "{env:", suffix: "}" },
    type: { stdio: "local", "streamable-http": "remote" },
    url: { "streamable-http": "httpUrl" },
    command: "array",
    env: "environment",
  };
  expect(mcpJson(local, codec)).toEqual({
    type: "local",
    command: ["npx", "-y", "srv@1.0.0", "--token={env:TOKEN}"],
    environment: { URL: "https://x.test", KEY: "{env:KEY}" },
  });
  expect(mcpJson(remote, codec)).toMatchObject({ type: "remote", httpUrl: "https://x.test/mcp" });
});

test("refuses a secret where the target expands none, or when it reads none at all", () => {
  const envOnly: McpJsonCodec = {
    id: "mcp-json",
    secret: { prefix: "$", suffix: "", in: ["env"] },
  };
  expect(mcpJson(local, envOnly)).toContain("secret in args");
  expect(mcpJson(remote, { id: "mcp-json" })).toContain("no way to read one");
});

test("writes allowed tools less denied ones, else the denied ones, where the target can", () => {
  const codec: McpJsonCodec = { ...claude, tools: { allow: ["tools", "include"], deny: ["x"] } };
  expect(mcpJson(remote, codec, { allow: ["a", "b"], deny: ["b"] })).toMatchObject({
    tools: { include: ["a"] },
  });
  expect(mcpJson(remote, codec, { deny: ["b"] })).toMatchObject({ x: ["b"] });
  expect(mcpJson(remote, { ...claude, tools: { allow: ["tools"] } }, { deny: ["b"] })).toContain(
    "denies some tools",
  );
  expect(mcpJson(remote, claude, { allow: ["a"] })).toContain("allows only some tools");
});
