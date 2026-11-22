import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils.ts";

/** `.form-input`: blue focus ring, as the original's dialogs used. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "w-full rounded-md border border-line bg-white px-2.5 py-2 text-[12px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-dim focus:border-accent focus:shadow-[0_0_0_2px_rgb(37_99_235/0.1)]",
          className,
        )}
        {...props}
      />
    );
  },
);
