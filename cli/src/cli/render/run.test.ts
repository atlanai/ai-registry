import { describe, expect, test } from "vitest";
import { FAILURES } from "#adapter/errors.ts";
import { RunErrorCode, type RunEvent, RunEventType } from "#core/run/model.ts";
import { Printer } from "#core/term/printer.ts";
import { eventLine, failureWords } from "./run.ts";

const printer = new Printer({ out: { write: () => true, isTTY: false }, color: "never" });

function event(eventType: string, fields: Partial<RunEvent> = {}): RunEvent {
  return {
    id: 1,
    runId: "run_1",
    seq: 1,
    occurredAtMs: 0,
    eventType,
    step: undefined,
    artifact: undefined,
    kind: undefined,
    disposition: undefined,
    operation: undefined,
    outcome: undefined,
    errorCode: undefined,
    retryable: false,
    data: {},
    ...fields,
  };
}

describe("eventLine", () => {
  test("names each phase in words", () => {
    expect(eventLine(printer, event(RunEventType.Phase, { step: "listing" }))).toBe(
      "  reading the registry",
    );
    expect(eventLine(printer, event(RunEventType.Phase, { step: "classifying" }))).toBe(
      "  comparing",
    );
  });

  test("leaves progress out, since each artifact's own line says what happened", () => {
    expect(eventLine(printer, event(RunEventType.Progress, { artifact: "lint" }))).toBeUndefined();
  });

  test("says what happened to an artifact, and why it needs you", () => {
    const pulled = event("item.settled", {
      artifact: "lint",
      outcome: "changed",
      operation: "pull",
    });
    expect(eventLine(printer, pulled)).toBe("  pulled     lint");
    const waiting = event("item.settled", {
      artifact: "lint",
      outcome: "attention",
      disposition: "publish",
      operation: "report",
      data: { detail: "edited here" },
    });
    expect(eventLine(printer, waiting)).toBe("  attention  lint  edited here");
  });

  test("ends with the state the run finished in, and why it failed in words", () => {
    const failed = event(RunEventType.Finished, {
      errorCode: "sync_failed",
      data: { state: "failed" },
    });
    expect(eventLine(printer, failed)).toBe("  finished   failed  stopped by an error");
    const reason = 'manifest.yml: Artifact "pr-review" names registry "pr-review".';
    expect(eventLine(printer, failed, reason)).toBe(`  finished   failed  ${reason}`);
    const refused = event(RunEventType.Finished, {
      errorCode: "adapter_unauthorized",
      data: { state: "failed" },
    });
    expect(eventLine(printer, refused)).toBe(
      "  finished   failed  the registry refused the sign-in",
    );
  });

  test("names every failure code in words", () => {
    for (const code of [...Object.values(RunErrorCode), ...FAILURES.map((f) => `adapter_${f}`)]) {
      expect(failureWords(code)).not.toMatch(/_/);
    }
  });
});
