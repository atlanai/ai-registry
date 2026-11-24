import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { chooseFiles } from "./files.ts";

test("publishes an MCP server's server.json first, as its entry", async ({ tmp }) => {
  const root = join(tmp, "issue-tracker");
  await mkdir(root);
  await writeFile(join(root, "README.md"), "# Issues\n");
  await writeFile(join(root, "server.json"), "{}\n");
  const chosen = await chooseFiles(
    { root, kind: "mcp_server", entries: [], tracked: undefined, exported: [root] },
    tmp,
  );
  expect(chosen.files.map((file) => file.from)).toEqual(["server.json", "README.md"]);
});
