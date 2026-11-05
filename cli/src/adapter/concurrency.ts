export const CONCURRENCY = 16;

export function limiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  const waiting: (() => void)[] = [];
  let active = 0;

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((admit) => waiting.push(admit));
    else active += 1;

    try {
      return await task();
    } finally {
      // Handed over, not released and retaken, which would let a third in.
      const next = waiting.shift();
      if (next === undefined) active -= 1;
      else next();
    }
  };
}

/**
 * Like `limiter`, but weighted: light tasks run together and a heavy one waits for room. A task
 * heavier than the whole budget still runs, alone, rather than never.
 */
export function weighted(
  budget: number,
): <T>(weight: number, task: () => Promise<T>) => Promise<T> {
  const waiting: { weight: number; admit: () => void }[] = [];
  let used = 0;
  const fits = (weight: number): boolean => used === 0 || used + weight <= budget;

  return async <T>(weight: number, task: () => Promise<T>): Promise<T> => {
    // In arrival order, so a stream of light tasks never starves a heavy one.
    if (waiting.length === 0 && fits(weight)) used += weight;
    else await new Promise<void>((admit) => waiting.push({ weight, admit }));

    try {
      return await task();
    } finally {
      used -= weight;
      for (let next = waiting[0]; next !== undefined && fits(next.weight); next = waiting[0]) {
        waiting.shift();
        used += next.weight;
        next.admit();
      }
    }
  };
}
