import { describe, expect, test } from "vitest";
import { isSha256Hex, sha256Hex, shortHash } from "#core/fs/hash.ts";

const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("hash", () => {
  test("digests bytes the way both release sources compare them", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(ABC);
  });

  test("recognizes only the lowercase hex digest it writes", () => {
    expect(isSha256Hex(ABC)).toBe(true);
    expect(isSha256Hex(ABC.toUpperCase())).toBe(false);
    expect(isSha256Hex(`sha256:${ABC}`)).toBe(false);
    expect(isSha256Hex(ABC.slice(1))).toBe(false);
  });

  test("shortens a key to the length asked for", () => {
    expect(shortHash("abc")).toBe(ABC.slice(0, 16));
    expect(shortHash("abc", 8)).toBe(ABC.slice(0, 8));
  });
});
