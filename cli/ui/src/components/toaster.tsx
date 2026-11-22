import { dismiss, useToasts } from "../lib/toast.ts";
import { cn } from "../lib/utils.ts";

const TONES = {
  info: "border-line",
  success: "border-ok-line",
  error: "border-bad-line",
};

export function Toaster() {
  const toasts = useToasts();
  return (
    <section
      aria-label="Notifications"
      aria-live="polite"
      className="fixed right-5 bottom-5 z-[110] flex w-80 flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.tone === "error" ? "alert" : "status"}
          className={cn(
            "animate-modal flex gap-2.5 rounded-lg border bg-surface px-3.5 py-3 shadow-popover",
            TONES[toast.tone],
          )}
        >
          <div className="min-w-0 flex-1 text-[12px]">
            <p
              className={cn("font-semibold", toast.tone === "error" ? "text-bad-ink" : "text-ink")}
            >
              {toast.title}
            </p>
            {toast.detail !== undefined && <p className="mt-0.5 text-muted">{toast.detail}</p>}
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(toast.id)}
            className="cursor-pointer self-start text-[16px] leading-none text-dim hover:text-ink"
          >
            &times;
          </button>
        </div>
      ))}
    </section>
  );
}
