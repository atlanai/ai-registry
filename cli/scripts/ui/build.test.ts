import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { pageFiles, render } from "./build.ts";

describe("the embedded page", () => {
  test("carries every built file, with its type and how long a browser may keep it", async ({
    tmp,
  }) => {
    await mkdir(join(tmp, "assets"));
    await writeFile(join(tmp, "index.html"), "<!doctype html>");
    await writeFile(join(tmp, "assets", "main-abc123.js"), "export {};");
    await writeFile(join(tmp, "assets", "logo-abc123.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const module = render(pageFiles(tmp));
    expect(module).toContain(
      '"/": {\n    type: "text/html; charset=utf-8",\n    immutable: false,',
    );
    expect(module).toContain(
      '"/assets/main-abc123.js": {\n    type: "text/javascript; charset=utf-8",\n    immutable: true,',
    );
    expect(module).toContain(`"${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}"`);
  });

  test("refuses a file it cannot name a type for", async ({ tmp }) => {
    await writeFile(join(tmp, "index.html"), "");
    await writeFile(join(tmp, "notes.unknown"), "");
    expect(() => render(pageFiles(tmp))).toThrow("no content type");
  });
});
