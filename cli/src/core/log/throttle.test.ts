import { describe, expect, test } from "vitest";
import { memorySink } from "#test/kit/memory-sink.ts";
import type { LogRecord } from "./model.ts";
import { throttleSink } from "./throttle.ts";

function record(body: string, atMs: number): LogRecord {
  return {
    timestamp: new Date(atMs).toISOString(),
    severity_text: "error",
    severity_number: 17,
    body,
    attributes: {},
  };
}

describe("throttleSink", () => {
  test("collapses the same message inside the window", () => {
    const inner = memorySink();
    const sink = throttleSink(inner, { windowMs: 60_000 });
    for (let i = 0; i < 10; i += 1) sink.write(record("stuck", 1_000 + i * 1_000));
    expect(inner.records).toHaveLength(1);
  });

  // Each info line is its own event; debug and trace are only written when asked for.
  test("passes info, debug and trace through", () => {
    const inner = memorySink();
    const sink = throttleSink(inner, { windowMs: 60_000 });
    for (let i = 0; i < 3; i += 1) {
      sink.write({
        ...record("run started", 1_000 + i),
        severity_text: "info",
        severity_number: 9,
      });
      sink.write({
        ...record("sync event", 1_000 + i),
        severity_text: "debug",
        severity_number: 5,
      });
      sink.write({ ...record("frame", 1_000 + i), severity_text: "trace", severity_number: 1 });
    }
    sink.close?.();
    expect(inner.records).toHaveLength(9);
    expect(inner.records.every((item) => item.attributes.repeated === undefined)).toBe(true);
  });

  test("reports how many it swallowed on the next one through", () => {
    const inner = memorySink();
    const sink = throttleSink(inner, { windowMs: 10_000 });
    sink.write(record("stuck", 0));
    for (let i = 1; i <= 5; i += 1) sink.write(record("stuck", i * 1_000));
    sink.write(record("stuck", 20_000));
    expect(inner.records).toHaveLength(2);
    expect(inner.records[1]?.attributes.repeated).toBe(5);
  });

  test("reports what it swallowed when it closes, so a burst that stopped still shows", () => {
    const inner = memorySink();
    const sink = throttleSink(inner, { windowMs: 60_000 });
    for (let i = 0; i < 4; i += 1) sink.write(record("stuck", 1_000 + i));
    sink.close?.();
    expect(inner.records.map((item) => item.attributes.repeated)).toEqual([undefined, 3]);
  });

  test("reports what it swallowed before it forgets a full key map", () => {
    const inner = memorySink();
    const sink = throttleSink(inner, { windowMs: 60_000, maxKeys: 2 });
    sink.write(record("stuck", 0));
    sink.write(record("stuck", 1));
    sink.write(record("other", 2));
    sink.write(record("third", 3));
    expect(inner.records.find((item) => item.attributes.repeated === 1)?.body).toBe("stuck");
  });

  test("keeps one job's failure from hiding another's", () => {
    const inner = memorySink();
    const sink = throttleSink(inner, { windowMs: 60_000 });
    for (const jobId of ["job_a", "job_b", "job_c"]) {
      sink.write({
        ...record("run failed", 1_000),
        attributes: { jobId, errorCode: "unreachable" },
      });
    }
    sink.write({
      ...record("run failed", 2_000),
      attributes: { jobId: "job_a", errorCode: "unreachable" },
    });
    expect(inner.records.map((item) => item.attributes.jobId)).toEqual(["job_a", "job_b", "job_c"]);
  });

  test("keeps distinct messages apart, even past the bound on the key map", () => {
    const inner = memorySink();
    const sink = throttleSink(inner, { windowMs: 60_000, maxKeys: 4 });
    for (let i = 0; i < 50; i += 1) sink.write(record(`unique-${i}`, i));
    expect(inner.records).toHaveLength(50);
  });
});
