import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "rounded border border-[rgb(15_23_42/0.08)] bg-[rgb(15_23_42/0.05)] px-[5px] py-px font-mono text-[10px] text-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
