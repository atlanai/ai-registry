import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

const TONES = {
  ok: "bg-ok-bg text-ok-ink",
  warn: "bg-warn-bg text-warn-ink",
  bad: "bg-bad-bg text-bad-ink",
  neutral: "bg-subtle text-muted",
} as const;

export type Tone = keyof typeof TONES;

/** A soft status pill in the body face; colour always comes with words. */
export function Badge({
  tone = "neutral",
  children,
  className,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 w-fit items-center gap-1 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
