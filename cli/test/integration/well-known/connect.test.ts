import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import adapter from "#adapters/well-known/index.ts";
import { sourceContext } from "#test/kit/source-context.ts";

test("stops reading an index once it passes the size limit", async () => {
  // A body with no length that never ends: only a reader that counts as it goes can stop.
  const chunk = Buffer.alloc(64 * 1024, 0x20);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const more = () => {
      while (!response.destroyed && response.write(chunk));
      if (!response.destroyed) response.once("drain", more);
    };
    more();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  try {
    const context = sourceContext({
      registry: "site",
      location: `http://localhost:${port}`,
      config: {},
      key: "sha256:k",
    });
    const handle = await adapter.connect(context);
    await expect(handle.resolve([])).rejects.toThrow(/is larger than aireg reads/);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}, 15_000);
