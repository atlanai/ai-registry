import { describeError } from "../lib/rpc.ts";

/** A refusal in the original's failed-pill colours, with the server's hint under it. */
export function ErrorNote({ error }: { error: unknown }) {
  const { title, hint } = describeError(error);
  return (
    <div
      role="alert"
      className="rounded-md border border-bad-line bg-bad-bg px-3 py-2.5 text-[12px]"
    >
      <p className="font-semibold text-bad-ink">{title}</p>
      {hint !== undefined && <p className="mt-0.5 text-ink-2">{hint}</p>}
    </div>
  );
}
