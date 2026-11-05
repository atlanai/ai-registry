import { describe, expect, test } from "vitest";
import { memorySink } from "#test/kit/memory-sink.ts";
import { createLogger } from "./logger.ts";

/** Shaped like a GitHub token, built here so the source holds no token-shaped literal. */
const TOKEN = `ghp_${"0".repeat(36)}`;

function setup(level: Parameters<typeof createLogger>[0]["level"] = "debug") {
  const sink = memorySink();
  return { sink, logger: createLogger({ sink, level }) };
}

describe("createLogger", () => {
  test("suppresses anything below the threshold", () => {
    const { sink, logger } = setup("warn");
    logger.debug("noise");
    logger.info("noise");
    logger.warn("kept");
    expect(sink.records.map((record) => record.body)).toEqual(["kept"]);
  });

  test("reports what it would emit without formatting it", () => {
    const { logger } = setup("warn");
    expect(logger.enabled("debug")).toBe(false);
    expect(logger.enabled("error")).toBe(true);
  });

  test("carries bound context onto every line below it", () => {
    const { sink, logger } = setup();
    logger.child({ runId: "run_1" }).child({ jobId: "w1" }).info("started");
    expect(sink.records[0]?.attributes).toMatchObject({ runId: "run_1", jobId: "w1" });
  });

  test("stamps the OTel severity alongside the name", () => {
    const { sink, logger } = setup();
    logger.error("boom");
    expect(sink.records[0]).toMatchObject({ severity_text: "error", severity_number: 17 });
  });

  test("lifts a thrown value out of the fields and keeps the cause chain", () => {
    const { sink, logger } = setup();
    logger.error("failed", { error: new Error("outer", { cause: new Error("inner") }) });
    const record = sink.records[0];
    expect(record?.attributes).not.toHaveProperty("error");
    expect(record?.error?.message).toBe("outer");
    expect(record?.error?.cause?.message).toBe("inner");
  });

  test("redacts a token that reaches a field", () => {
    const { sink, logger } = setup();
    logger.info("calling", { authorization: `Bearer ${TOKEN}` });
    expect(JSON.stringify(sink.records[0])).not.toContain(TOKEN);
  });

  test("redacts a credential quoted in an error message", () => {
    const { sink, logger } = setup();
    logger.error("clone failed", {
      error: new Error(`fatal: unable to access 'https://x:${TOKEN}@github.com/a/b'`),
    });
    logger.error("request failed", {
      error: new Error(`rejected: Authorization: Bearer ${TOKEN}`),
    });
    expect(sink.records).toHaveLength(2);
    expect(JSON.stringify(sink.records)).not.toContain(TOKEN);
  });
});
