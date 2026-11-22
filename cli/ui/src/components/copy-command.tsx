import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "../lib/toast.ts";
import { cn } from "../lib/utils.ts";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Copies, and says so on the control for a moment, as the original's buttons did. */
export function useCopy(): [string | undefined, (text: string) => void] {
  const [copied, setCopied] = useState<string>();
  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(text);
        setTimeout(() => setCopied(undefined), 1500);
      },
      () => toast("error", "Could not copy", "The browser refused clipboard access."),
    );
  };
  return [copied, copy];
}

/** The exact `aireg` command, so anything done here can be done from a terminal. */
export function CopyCommand({ command, className }: { command: string; className?: string }) {
  const [copied, copy] = useCopy();
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-hairline bg-subtle py-1 pr-1 pl-2.5 font-mono text-[11.5px] text-ink",
        className,
      )}
    >
      <span className="text-dim select-none">$</span>
      <code className="min-w-0 flex-1 truncate" title={command}>
        {command}
      </code>
      <button
        type="button"
        onClick={() => copy(command)}
        aria-label="Copy command"
        className="cursor-pointer rounded p-1 text-dim hover:bg-surface hover:text-ink"
      >
        {copied === command ? (
          <Check className="size-3.5 text-ok-ink" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
    </div>
  );
}
