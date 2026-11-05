import { describe, expect, test } from "vitest";
import { ErrorCode } from "#core/errors.ts";
import { refuseInsecure } from "./load.ts";

describe("a registry address without transport security", () => {
  test("is refused over git:// and plain http://, with the address to use instead", () => {
    for (const location of [
      "git://example.com/acme/kit",
      "http://example.com/acme/kit",
      "HTTP://github.com/acme/kit",
      "http://127.0.0.1.example.com/acme/kit",
      "http://[::ffff:7f00:1]/acme/kit",
    ]) {
      expect(() => refuseInsecure(location), location).toThrow(
        expect.objectContaining({
          code: ErrorCode.Usage,
          hint: expect.stringContaining("https://"),
        }),
      );
    }
  });

  test("is allowed over http:// on this machine, where no network carries it", () => {
    for (const location of [
      "http://localhost:8080/acme/kit",
      "http://registry.localhost/acme",
      "http://127.0.0.1/acme/kit",
      "http://127.8.9.10:9/acme/kit",
      "http://[::1]:8080/acme/kit",
      "https://example.com/acme/kit",
      "ssh://git@example.com/acme/kit",
      "./acme",
      "github.com/acme/kit",
    ]) {
      expect(() => refuseInsecure(location), location).not.toThrow();
    }
  });
});
