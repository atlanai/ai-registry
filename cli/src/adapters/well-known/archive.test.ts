import { describe, expect, test } from "vitest";
import { tarGz, zip } from "#test/kit/site.ts";
import { unpack } from "./archive.ts";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("unpack", () => {
  test("reads a .tar.gz, keeping which files are executable", () => {
    const files = unpack(
      "fill",
      tarGz([
        { path: "SKILL.md", body: "Fill.\n" },
        { path: "./scripts/fill.sh", body: "#!/bin/sh\n", mode: 0o755 },
      ]),
    );
    expect(files.map((file) => [file.path, text(file.bytes), file.executable])).toEqual([
      ["SKILL.md", "Fill.\n", false],
      ["scripts/fill.sh", "#!/bin/sh\n", true],
    ]);
  });

  test("reads a .zip", () => {
    const files = unpack("fill", zip({ "SKILL.md": "Fill.\n", "references/a.md": "A.\n" }));
    expect(files.map((file) => file.path)).toEqual(["SKILL.md", "references/a.md"]);
  });

  test("refuses a path that leaves the archive, and an absolute one", () => {
    expect(() => unpack("fill", tarGz([{ path: "../escape", body: "x" }]))).toThrow(
      `fill's archive holds "../escape", which is not a path inside it.`,
    );
    expect(() => unpack("fill", zip({ "/etc/passwd": "x" }))).toThrow(/not a path inside it/);
  });

  test("refuses a link", () => {
    expect(() => unpack("fill", tarGz([{ path: "outside", link: "/etc/passwd" }]))).toThrow(
      `fill's archive holds "outside", which is a link.`,
    );
  });

  test("stops at its file and byte limits", () => {
    const many = tarGz([
      { path: "a", body: "1" },
      { path: "b", body: "2" },
    ]);
    expect(() => unpack("fill", many, { bytes: 1024, files: 1 })).toThrow(
      "fill's archive holds more than 1 file.",
    );
    const big = tarGz([{ path: "a", body: "x".repeat(2048) }]);
    expect(() => unpack("fill", big, { bytes: 1024, files: 10 })).toThrow(/unpacks to more than/);
  });

  test("refuses what is neither a .tar.gz nor a .zip", () => {
    expect(() => unpack("fill", new TextEncoder().encode("plain"))).toThrow(
      "fill's archive is neither a .tar.gz nor a .zip file.",
    );
  });
});
