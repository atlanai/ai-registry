import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils.ts";

const VARIANTS = {
  default: "border-line bg-surface text-ink shadow-subtle hover:bg-subtle",
  ghost: "border-transparent text-ink-2 hover:bg-subtle hover:text-ink",
  primary: "border-ink bg-ink text-white shadow-subtle hover:bg-ink-hover",
  accent:
    "border-accent bg-accent text-white shadow-subtle hover:border-accent-hover hover:bg-accent-hover",
  danger: "border-bad-ink bg-bad-ink text-white hover:border-bad-hover hover:bg-bad-hover",
  retire:
    "border-line bg-surface text-ink shadow-subtle hover:border-bad-line hover:bg-bad-bg hover:text-bad-ink",
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "default", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-[background-color,border-color,color,transform] duration-100 ease-out-expo select-none active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
});
