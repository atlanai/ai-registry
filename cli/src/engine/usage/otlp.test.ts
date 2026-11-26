import { describe, expect, test } from "vitest";
import type { Run } from "./model.ts";
import { RUN_SPAN, reporterFor, traceRequest } from "./otlp.ts";

const KEY = Buffer.alloc(32, 7);
const RUN: Run = {
  id: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
  at: "2026-11-24T09:41:27.512Z",
  target: "codex",
  trigger: "model",
  registry: "sha256:registry",
  alias: "acme",
  ref: "engineering/skill/pr-review@1.2.0",
  digest: "sha256:9cf6",
};
const USAGE = {
  otlp: "https://otel.example.com",
  reporter: "pseudonym" as const,
  timePrecision: "hour" as const,
};

describe("traceRequest", () => {
  test("sends each run as a zero-length span carrying section 14.3's attributes", () => {
    const request = traceRequest(
      [RUN],
      { name: "acme", url: "https://acme.example", usage: USAGE },
      "r-1",
    );
    const [resource] = request.resourceSpans;
    expect(resource?.resource.attributes.map((a) => a.key)).toEqual([
      "registry.usage.reporter",
      "registry.name",
      "registry.url",
      "service.name",
      "service.version",
    ]);
    const span = resource?.scopeSpans[0]?.spans[0];
    expect(span).toMatchObject({
      name: RUN_SPAN,
      kind: 1,
      startTimeUnixNano: "1795510800000000000",
      endTimeUnixNano: "1795510800000000000",
    });
    expect(span?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.fromEntries((span?.attributes ?? []).map((a) => [a.key, a.value]))).toEqual({
      "registry.artifact.ref": { stringValue: RUN.ref },
      "registry.artifact.digest": { stringValue: RUN.digest },
      "registry.run.id": { stringValue: RUN.id },
      "registry.run.trigger": { stringValue: "model" },
      "registry.target": { stringValue: "codex" },
    });
  });

  test("rounds the time down to the precision the registry asks for", () => {
    const times = (["second", "hour", "day"] as const).map((timePrecision) => {
      const request = traceRequest(
        [RUN],
        { name: "acme", usage: { ...USAGE, timePrecision } },
        "r-1",
      );
      return request.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.startTimeUnixNano;
    });
    expect(times).toEqual(["1795513287000000000", "1795510800000000000", "1795478400000000000"]);
  });

  test("sends the same run as the same span", () => {
    const ids = [1, 2].map(() => {
      const span = traceRequest([RUN], { name: "acme", usage: USAGE }, "r-1").resourceSpans[0]
        ?.scopeSpans[0]?.spans[0];
      return [span?.traceId, span?.spanId];
    });
    expect(ids[0]).toEqual(ids[1]);
  });
});

describe("reporterFor", () => {
  test("gives each registry its own pseudonym, stable for one key", () => {
    const first = reporterFor(USAGE, "sha256:a", undefined, KEY);
    expect(first).toMatch(/^r-[0-9a-f]{16}$/);
    expect(reporterFor(USAGE, "sha256:a", undefined, KEY)).toBe(first);
    expect(reporterFor(USAGE, "sha256:b", undefined, KEY)).not.toBe(first);
    expect(reporterFor(USAGE, "sha256:a", undefined, Buffer.alloc(32, 8))).not.toBe(first);
  });

  test("uses the name you chose only for a registry that asks for names", () => {
    expect(reporterFor({ ...USAGE, reporter: "name" }, "sha256:a", "jo", KEY)).toBe("jo");
    expect(reporterFor(USAGE, "sha256:a", "jo", KEY)).toMatch(/^r-/);
  });
});
