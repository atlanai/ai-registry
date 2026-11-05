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
