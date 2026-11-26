import { describe, expect, test } from "vitest";
import { headersOf } from "./send.ts";

describe("headersOf", () => {
  test("reads key=value pairs for one registry, percent-decoding each value", () => {
    const env = { AIREG_USAGE_HEADERS_ACME_PROD: "x-api-key=k%3D1, Authorization=Basic%20abc" };
    expect(headersOf("acme-prod", env)).toEqual({ "x-api-key": "k=1", Authorization: "Basic abc" });
  });

  test("never hands one registry's headers to another", () => {
    const env = { AIREG_USAGE_HEADERS_ACME: "x-api-key=secret" };
    expect(headersOf("tools", env)).toEqual({});
  });

  test("skips a pair with no key, and keeps a value that will not decode as written", () => {
    expect(headersOf("acme", { AIREG_USAGE_HEADERS_ACME: "=x,bare,k=%E0" })).toEqual({ k: "%E0" });
    expect(headersOf("acme", {})).toEqual({});
  });
});
