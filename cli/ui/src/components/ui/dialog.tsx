import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

export const Dialog = DialogPrimitive.Root;
export const DialogClose = DialogPrimitive.Close;

/** The original's `.doctor-modal`: blurred slate backdrop, 12px card, a mono tag by the title. */
export function DialogContent({
  title,
  tag,
  children,
  className,
}: {
  title: ReactNode;
  tag?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="animate-fade-in fixed inset-0 z-[100] bg-[rgb(15_23_42/0.35)] backdrop-blur-[6px]" />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className={cn(
          "animate-modal fixed top-1/2 left-1/2 z-[101] flex max-h-[82vh] w-[min(660px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-popover focus:outline-none",
          className,
        )}
      >
        <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            {tag !== undefined && (
              <span className="inline-flex w-fit shrink-0 rounded border border-ok-line bg-ok-bg px-[7px] py-0.5 font-mono text-[10.5px] font-semibold text-ok-ink">
                {tag}
              </span>
            )}
            <DialogPrimitive.Title className="truncate text-[15px] font-[650] text-ink">
              {title}
            </DialogPrimitive.Title>
          </div>
          <DialogPrimitive.Close
            aria-label="Close"
            className="min-h-7 min-w-7 cursor-pointer text-[20px] leading-none text-dim hover:text-ink"
          >
            &times;
          </DialogPrimitive.Close>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-5 py-[18px]">
          {children}
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
