import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { sha256Hex } from "#core/fs/hash.ts";
import { test } from "#test/kit/fixtures.ts";
import {
  assertInstallRecord,
  installRecordPath,
  parseDispatch,
  parseInstallRecord,
  readInstallRecord,
  writeInstallRecord,
} from "./record.ts";

describe("install record", () => {
  test("round-trips dispatch and refuses a swapped module", async ({ tmp }) => {
    const dir = tmp;
    const modulePath = join(dir, "adapter.mjs");
    const bytes = new TextEncoder().encode("export default {}\n");
    await writeFile(modulePath, bytes);
    await writeInstallRecord(modulePath, {
      id: "acme",
      sha256: sha256Hex(bytes),
      protocol: 1,
      dispatch: { hosts: ["acme.example"] },
    });
    expect(parseInstallRecord(await readFile(installRecordPath(modulePath), "utf8"))).toEqual({
      id: "acme",
      sha256: sha256Hex(bytes),
      protocol: 1,
      dispatch: { hosts: ["acme.example"] },
    });
    await assertInstallRecord(modulePath, "acme");
    await writeFile(modulePath, "export default { tampered: true }\n");
    await expect(assertInstallRecord(modulePath, "acme")).rejects.toThrow(/install record/);
  });

  test("refuses a present file that is not a record", async ({ tmp }) => {
    const dir = tmp;
    const modulePath = join(dir, "adapter.mjs");
    await writeFile(modulePath, "export default {}\n");
    await writeFile(installRecordPath(modulePath), "{}\n");
    await expect(readInstallRecord(modulePath)).rejects.toThrow(/not a valid install record/);
  });

  test("reads only a record of its own schema with no extra keys", () => {
    const record = {
      schema: "aireg-adapter-install.v1",
      id: "acme",
      sha256: "a".repeat(64),
      protocol: 1,
      dispatch: { hosts: ["acme.example"] },
    };
    expect(parseInstallRecord(JSON.stringify(record))).toBeDefined();
    expect(parseInstallRecord(JSON.stringify({ ...record, schema: "other.v1" }))).toBeUndefined();
    expect(parseInstallRecord(JSON.stringify({ ...record, extra: true }))).toBeUndefined();
    expect(
      parseInstallRecord(
        JSON.stringify({ ...record, dispatch: { ...record.dispatch, extra: true } }),
      ),
    ).toBeUndefined();
  });
});

describe("parseDispatch", () => {
  test("reads a site claim, and refuses one it cannot read", () => {
    const sites = { schemes: ["https"], exceptHosts: ["github.com"], exceptSuffixes: [".git"] };
    expect(parseDispatch({ sites })).toEqual({ sites });
    expect(parseDispatch({ sites: { schemes: "https" } })).toBeUndefined();
    expect(parseDispatch({ sites: { schemes: ["https"], other: true } })).toBeUndefined();
  });
});
