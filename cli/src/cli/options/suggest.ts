import { quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";

export function closest(typed: string, candidates: readonly string[]): string | undefined {
  // Short words are a letter or two from everything, so they get less slack.
  const cap = Math.min(2, Math.floor(typed.length / 2));
  let best: string | undefined;
  let bestDistance = cap + 1;
  for (const candidate of candidates) {
    const d = distance(typed, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

/** Optimal string alignment: an adjacent swap costs one, as `stauts` should. */
function distance(a: string, b: string): number {
  const width = b.length + 1;
  const d = Array.from({ length: (a.length + 1) * width }, (_, k) =>
    k < width ? k : k % width === 0 ? k / width : 0,
  );
  const at = (i: number, j: number) => d[i * width + j] as number;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, at(i - 2, j - 2) + 1);
      }
      d[i * width + j] = best;
    }
  }
  return at(a.length, b.length);
}

export function didYouMean(guess: string | undefined, hint: string): string {
  return guess === undefined ? hint : `Did you mean \`${guess}\`? ${hint}`;
}

export function unknownAction(
  path: string,
  typed: string,
  actions: readonly string[],
  hint: string,
): AiregError {
  const near = closest(typed, actions);
  return new AiregError(`Unknown ${path} action ${quoted(typed)}.`, {
    code: ErrorCode.Usage,
    hint: didYouMean(near === undefined ? undefined : `aireg ${path} ${near}`, hint),
  });
}
