import { cn } from "../lib/utils.ts";

const TONES = {
  core: "border-core-line bg-core-bg text-core-ink",
  growth: "border-growth-line bg-growth-bg text-growth-ink",
  style: "border-style-line bg-style-bg text-style-ink",
  studio: "border-studio-line bg-studio-bg text-studio-ink",
  aireg: "border-aireg-line bg-aireg-bg text-aireg-ink",
} as const;
const ORDER = Object.keys(TONES) as (keyof typeof TONES)[];

/** The original's five namespace pastels; a namespace it never named keeps one by its letters. */
function tone(namespace: string): keyof typeof TONES {
  const named = ORDER.find((name) => name === namespace.toLowerCase());
  if (named !== undefined) return named;
  let sum = 0;
  for (const char of namespace) sum += char.charCodeAt(0);
  return ORDER[sum % ORDER.length] ?? "core";
}

export function NamespacePill({
  namespace,
  large = false,
}: {
  namespace: string;
  large?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border font-medium whitespace-nowrap",
        large ? "h-5 px-2 text-[11.5px]" : "h-[18px] px-1.5 text-[11px]",
        TONES[tone(namespace)],
      )}
    >
      {namespace}
    </span>
  );
}
