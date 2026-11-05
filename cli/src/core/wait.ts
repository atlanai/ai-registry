import { setTimeout as sleep } from "node:timers/promises";

/** Checks `done` every `everyMs` until it holds or `timeoutMs` passes; false when it never held. */
export async function pollUntil(
  done: () => boolean | Promise<boolean>,
  timeoutMs: number,
  everyMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await done()) return true;
    await sleep(everyMs);
  }
  return false;
}

/** Waits for the work to settle or `ms` to pass, whichever is first; nothing is canceled. */
export async function settledWithin(work: Iterable<Promise<unknown>>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled(work),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
}
