import { describe, expect } from "vitest";
import { registerBuiltinAdapters } from "#adapters/index.ts";
import { emptyRegistryConfig } from "#core/config/model.ts";
import { parseManifest } from "#core/manifest/parse.ts";
import { homeTest as test } from "#test/kit/fixtures.ts";
import { readAccounts } from "./accounts.ts";

describe("readAccounts", () => {
  test("shows a declared address without its escapes or its userinfo", async () => {
    registerBuiltinAdapters();
    const manifest = parseManifest(
      `registries:\n  acme: "https://user:secret@example.com/acme\\u001B]52;c;Zm9v\\u0007"\n`,
    );
    const config = { ...emptyRegistryConfig(), accounts: [{ id: "acc_one", registry: "acme" }] };

    const [row] = await readAccounts(config, manifest, { byAlias: {} });

    expect(row?.address).toBe("https://<redacted>@example.com/acme");
  });
});
