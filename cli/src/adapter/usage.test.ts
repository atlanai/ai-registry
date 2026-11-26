import { describe, expect, test } from "vitest";
import { usageOf } from "./usage.ts";

describe("usageOf", () => {
  test("reads registry.json's block, filling the defaults", () => {
    expect(usageOf({ otlp: "https://otel.example.com/" })).toEqual({
      otlp: "https://otel.example.com",
      reporter: "pseudonym",
      timePrecision: "hour",
    });
    expect(
      usageOf({ otlp: "http://localhost:4318", reporter: "name", time_precision: "second" }),
    ).toEqual({
      otlp: "http://localhost:4318",
      reporter: "name",
      timePrecision: "second",
    });
  });

  test("reads an adapter's identity, which spells the precision in camel case", () => {
    expect(usageOf({ otlp: "http://127.0.0.1:6006", timePrecision: "day" })?.timePrecision).toBe(
      "day",
    );
  });

  test("reads a block a client may not follow as no usage at all", () => {
    for (const otlp of [
      "http://otel.example.com",
      "http://localhost.example.com",
      "ftp://otel.example.com",
      "https://otel.example.com/v1/traces",
      "",
    ]) {
      expect(usageOf({ otlp }), otlp).toBeUndefined();
    }
    expect(usageOf({ otlp: "https://otel.example.com", reporter: "email" })).toBeUndefined();
    expect(usageOf({ otlp: "https://otel.example.com", time_precision: "minute" })).toBeUndefined();
    expect(usageOf("https://otel.example.com")).toBeUndefined();
  });
});
