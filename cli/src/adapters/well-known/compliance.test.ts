import { join } from "node:path";
import { expect } from "vitest";
import { assertAdapterCompliance } from "#adapter/index.ts";
import { test } from "#test/kit/fixtures.ts";
import { serveFolder, tarGz, wellKnownSite } from "#test/kit/site.ts";
import { sourceContext } from "#test/kit/source-context.ts";
import adapter from "./index.ts";

test("meets the public adapter contract against a site's index", async ({ tmp }) => {
  const root = await wellKnownSite(join(tmp, "site"), [
    { name: "greet" },
    {
      name: "fill",
      type: "archive",
      archive: tarGz([
        { path: "SKILL.md", body: "---\nname: fill\ndescription: Fill.\n---\nFill.\n" },
        { path: "scripts/fill.sh", body: "#!/bin/sh\n", mode: 0o755 },
      ]),
    },
  ]);
  const site = await serveFolder(root);
  try {
    const context = sourceContext(
      { registry: "site", location: site.url, config: {}, key: "sha256:k" },
      join(tmp, "cache"),
    );
    await expect(assertAdapterCompliance(adapter, context)).resolves.toBeUndefined();
  } finally {
    await site.close();
  }
});
