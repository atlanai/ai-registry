import { describe, expect, test } from "vitest";
import { hashStream, sha256 } from "./canonical.ts";

const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("sha256", () => {
  test("gives a digest in the sha256:<hex> form, from text or bytes alike", () => {
    expect(sha256("abc")).toBe(`sha256:${ABC}`);
  });

  test("digests a stream chunk by chunk to the same answer", async () => {
    async function* chunks() {
      yield new TextEncoder().encode("a");
      yield new TextEncoder().encode("bc");
    }
    expect(await hashStream(chunks())).toEqual({ digest: `sha256:${ABC}`, size: 3 });
  });
});
