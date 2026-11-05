import { describe, expect, test } from "vitest";
import { pollUntil, settledWithin } from "./wait.ts";

describe("pollUntil", () => {
  test("answers true as soon as the check holds", async () => {
    let calls = 0;
    expect(await pollUntil(() => ++calls === 3, 1_000, 1)).toBe(true);
    expect(calls).toBe(3);
  });

  test("answers false once the time runs out", async () => {
    expect(await pollUntil(() => false, 20, 5)).toBe(false);
  });
});

describe("settledWithin", () => {
  test("returns once the work settles, rejected or not", async () => {
    const started = Date.now();
    await settledWithin([Promise.reject(new Error("no")), Promise.resolve()], 5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("returns after the time runs out, leaving the work running", async () => {
    let finished = false;
    const work = new Promise<void>((resolve) => setTimeout(resolve, 200)).then(() => {
      finished = true;
    });
    await settledWithin([work], 10);
    expect(finished).toBe(false);
    await work;
  });
});
