import { expect, test } from "vitest";
import { mcpJson } from "#core/target/codecs/mcp-json.ts";
import type { McpJsonCodec } from "#core/target/contract.ts";
import { geminiCli } from "#targets/gemini-cli.ts";

const mapping = geminiCli.kinds.mcp_server;
const codec = (mapping?.shape === "config" ? mapping.codec : undefined) as McpJsonCodec;

test("marks an SSE server as sse, since Gemini CLI reads a bare url as streamable HTTP", () => {
  expect(mcpJson({ transport: "sse", url: "https://x.test/sse", headers: {} }, codec)).toEqual({
    type: "sse",
    url: "https://x.test/sse",
  });
});

test("writes a secret in a header, which Gemini CLI expands", () => {
  const entry = {
    transport: "streamable-http" as const,
    url: "https://x.test/mcp",
    headers: { Authorization: ["Bearer ", { secret: "TOKEN" }] },
  };
  expect(mcpJson(entry, codec)).toEqual({
    httpUrl: "https://x.test/mcp",
    headers: { Authorization: `Bearer \${TOKEN}` },
  });
});
