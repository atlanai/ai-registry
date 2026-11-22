import type { ReactNode } from "react";

/** The original's dashboard frame: a 24px title, a lead, then sections of cards and tables. */
export function Dashboard({
  title,
  lead,
  actions,
  children,
}: {
  title: string;
  lead: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex-1 overflow-y-auto bg-canvas px-12 pt-8 pb-20 max-[1100px]:px-5">
      <div className="mx-auto flex w-full max-w-[1060px] flex-col gap-7">
        <div className="flex items-start justify-between gap-5 border-b border-hairline pb-5">
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">{title}</h1>
            <p className="mt-1 text-[13.5px] leading-normal text-ink-2">{lead}</p>
          </div>
          {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Metrics({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-4 divide-x divide-hairline rounded-lg border border-hairline bg-surface max-[1100px]:grid-cols-2 max-[1100px]:divide-x-0">
      {children}
    </div>
  );
}

export function Metric({
  label,
  value,
  sub,
  dot,
}: {
  label: string;
  value: ReactNode;
  sub: ReactNode;
  dot?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 px-5 py-4">
      <span className="text-[12.5px] text-muted">{label}</span>
      <div className="flex items-center gap-2">
        {dot === true && (
          <span className="size-1.5 rounded-full bg-pulse shadow-[0_0_0_2px_rgb(16_185_129/0.2)]" />
        )}
        <span className="text-[20px] font-semibold tracking-[-0.02em] text-ink tabular-nums">
          {value}
        </span>
      </div>
      <span className="text-[12px] text-dim">{sub}</span>
    </div>
  );
}

export function Section({
  title,
  note,
  aside,
  children,
}: {
  title: string;
  note?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
          {note !== undefined && <p className="mt-0.5 text-[12px] text-muted">{note}</p>}
        </div>
        {aside !== undefined && <span className="text-[12px] text-dim">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-hairline bg-surface">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            {head.map((label) => (
              <th
                key={label}
                className="border-b border-hairline px-4 py-2 text-[12px] font-medium whitespace-nowrap text-muted"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_td]:border-b [&_td]:border-hairline [&_td]:px-4 [&_td]:py-2.5 [&_td]:text-[12.5px] [&_td]:text-ink-2 [&_tr:last-child_td]:border-b-0">
          {children}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyRow({ span, children }: { span: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={span} className="text-center text-muted italic">
        {children}
      </td>
    </tr>
  );
}
