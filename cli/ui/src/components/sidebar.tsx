import * as Tabs from "@radix-ui/react-tabs";
import { ChevronRight, CircleCheck, Layers, RefreshCw, Search, Shield } from "lucide-react";
import { forwardRef, type ReactNode, useState } from "react";
import type { UiRegistry, UiState } from "../../../src/cli/ui/protocol.ts";
import { counts, installed, namespaceOf, needsLook } from "../lib/state.ts";
import type { AuditFilter, View } from "../lib/url-state.ts";
import { cn, every } from "../lib/utils.ts";
import { Tooltip } from "./ui/tooltip.tsx";

/** One row shape for every list in the sidebar: 28px, a 14px lead slot, a right-aligned count. */
const ROW =
  "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] text-ink-2 transition-[background-color,color] duration-100 hover:bg-subtle hover:text-ink focus-visible:outline-offset-[-2px]";
const ROW_ACTIVE = "bg-[rgb(15_23_42/0.06)] font-medium text-ink hover:bg-[rgb(15_23_42/0.06)]";
const COUNT = "ml-auto shrink-0 text-[12px] text-dim tabular-nums";

function Lead({ children }: { children?: ReactNode }) {
  return (
    <span
      aria-hidden
      className="flex w-3.5 shrink-0 items-center justify-center text-dim [&_svg]:size-3.5"
    >
      {children}
    </span>
  );
}

function ModeItem({
  value,
  icon,
  label,
  count,
  warn = false,
}: {
  value: string;
  icon: ReactNode;
  label: string;
  count?: number | undefined;
  warn?: boolean;
}) {
  return (
    <Tabs.Trigger
      value={value}
      className={cn(
        ROW,
        "data-[state=active]:bg-[rgb(15_23_42/0.06)] data-[state=active]:font-medium data-[state=active]:text-ink",
      )}
    >
      <Lead>{icon}</Lead>
      <span className="truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className={cn(COUNT, warn && "font-medium text-warn-ink")}>{count}</span>
      )}
    </Tabs.Trigger>
  );
}

export function ModeSwitcher({ state }: { state: UiState | undefined }) {
  return (
    <Tabs.List aria-label="Views" className="flex flex-col gap-px px-2 pt-3 pb-2">
      <ModeItem
        value="artifacts"
        icon={<Layers />}
        label="Artifacts"
        count={state?.artifacts.length}
      />
      <ModeItem
        value="jobs"
        icon={<RefreshCw />}
        label="Jobs and runs"
        count={state?.runs.length}
      />
      <ModeItem
        value="audit"
        icon={<Shield />}
        label="Needs a look"
        count={state === undefined ? undefined : needsLook(state.artifacts, "all").length}
        warn
      />
    </Tabs.List>
  );
}

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mt-3 first:mt-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group flex h-7 w-full cursor-pointer items-center gap-1 rounded-md px-2 text-left text-[12px] font-medium text-muted transition-colors hover:text-ink focus-visible:outline-offset-[-2px]"
      >
        {title}
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 text-dim opacity-0 transition-[transform,opacity] group-hover:opacity-100 group-focus-visible:opacity-100",
            open && "rotate-90",
          )}
        />
      </button>
      {open && <ul className="flex flex-col gap-px">{children}</ul>}
    </section>
  );
}

function Item({
  active,
  onClick,
  lead,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  lead?: ReactNode;
  label: string;
  count?: number | undefined;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={active}
        onClick={onClick}
        className={cn(ROW, active && ROW_ACTIVE)}
      >
        <Lead>{lead}</Lead>
        <span className="min-w-0 truncate">{label}</span>
        {count !== undefined && <span className={COUNT}>{count}</span>}
      </button>
    </li>
  );
}

function Dot({ className }: { className: string }) {
  return <span className={cn("size-1.5 rounded-full", className)} />;
}

function registryDot(registry: UiRegistry): string {
  if (registry.loading) return "bg-dot-studio animate-pulse motion-reduce:animate-none";
  return registry.error === undefined ? "bg-pulse" : "bg-bad-ink";
}

function RegistryRow({ registry }: { registry: UiRegistry }) {
  let detail = `${registry.installed} of ${registry.count} installed`;
  if (registry.loading) detail = "Reading…";
  else if (registry.error !== undefined) detail = "Unreachable";
  return (
    <li>
      <Tooltip
        label={
          <span className="flex flex-col gap-0.5">
            <span className="font-mono">{registry.address}</span>
            {registry.error !== undefined && (
              <span className="text-bad-line">{registry.error}</span>
            )}
          </span>
        }
      >
        <div className={cn(ROW, "cursor-default")}>
          <Lead>
            <Dot className={registryDot(registry)} />
          </Lead>
          <span className="min-w-0 truncate">{registry.name}</span>
          <span className={cn(COUNT, registry.error !== undefined && "text-bad-ink")} aria-hidden>
            {registry.error === undefined ? `${registry.installed}/${registry.count}` : "Offline"}
          </span>
          <span className="sr-only">{detail}</span>
        </div>
      </Tooltip>
    </li>
  );
}

export const FilterBox = forwardRef<
  HTMLInputElement,
  { value: string; onChange: (value: string) => void }
>(function FilterBox({ value, onChange }, ref) {
  return (
    <div className="px-2 pb-2">
      <div className="relative flex items-center">
        <Search aria-hidden className="pointer-events-none absolute left-2 size-3.5 text-dim" />
        <input
          ref={ref}
          type="search"
          name="filter"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") event.currentTarget.blur();
          }}
          aria-label="Filter artifacts"
          placeholder="Filter…"
          autoComplete="off"
          spellCheck={false}
          className="h-7 w-full rounded-md border border-transparent bg-[rgb(15_23_42/0.045)] pr-7 pl-7 text-[13px] text-ink transition-[background-color,border-color] outline-none placeholder:text-dim hover:bg-[rgb(15_23_42/0.06)] focus:border-line focus:bg-surface"
        />
        <kbd className="pointer-events-none absolute right-1.5 rounded border border-hairline bg-surface px-1 text-[10.5px] leading-4 text-dim">
          /
        </kbd>
      </div>
    </div>
  );
});

export function ArtifactsNav({
  state,
  view,
  setView,
}: {
  state: UiState | undefined;
  view: View;
  setView: (patch: Partial<View>) => void;
}) {
  const artifacts = state?.artifacts ?? [];
  const registries = state?.registries ?? [];
  return (
    <nav aria-label="Filters" className="px-2 pb-4">
      <Section title="Namespaces">
        <Item
          active={view.namespace === undefined}
          onClick={() => setView({ namespace: undefined })}
          label="All"
          count={artifacts.length}
        />
        {counts(artifacts.map(namespaceOf)).map(([namespace, count]) => (
          <Item
            key={namespace}
            active={view.namespace === namespace}
            onClick={() =>
              setView({ namespace: view.namespace === namespace ? undefined : namespace })
            }
            label={namespace}
            count={count}
          />
        ))}
      </Section>
      <Section title="Targets">
        <Item
          active={view.target === undefined}
          onClick={() => setView({ target: undefined })}
          label="All"
        />
        {counts(artifacts.flatMap((artifact) => artifact.harnesses)).map(([target, count]) => (
          <Item
            key={target}
            active={view.target === target}
            onClick={() => setView({ target: view.target === target ? undefined : target })}
            label={target}
            count={count}
          />
        ))}
      </Section>
      <Section title="Registries">
        {registries.length === 0 && (
          <li className="px-2 py-1 text-[12px] leading-snug text-muted">
            None yet. Use Add to install from one.
          </li>
        )}
        {registries.map((registry) => (
          <RegistryRow key={registry.name} registry={registry} />
        ))}
      </Section>
    </nav>
  );
}

export function JobsNav({ state }: { state: UiState | undefined }) {
  const interval = state?.jobs.find((job) => job.intervalSeconds !== undefined)?.intervalSeconds;
  const running = state?.daemon.running ?? false;
  return (
    <div className="px-2 pb-4">
      <Section title="Daemon">
        <li className={cn(ROW, "cursor-default hover:bg-transparent")}>
          <Lead>
            <Dot className={running ? "bg-pulse" : "bg-faint"} />
          </Lead>
          {running ? "Running" : "Stopped"}
          <span className={COUNT}>{state?.daemon.detail}</span>
        </li>
        <li className={cn(ROW, "cursor-default hover:bg-transparent")}>
          <Lead />
          Syncs every
          <span className={COUNT}>{every(interval)}</span>
        </li>
      </Section>
      <Section title="Jobs">
        {(state?.jobs ?? []).length === 0 && (
          <li className="px-2 py-1 text-[12px] text-muted">No background jobs.</li>
        )}
        {state?.jobs.map((job) => (
          <li key={job.id} className={cn(ROW, "cursor-default hover:bg-transparent")}>
            <Lead>
              <Dot className={job.enabled ? "bg-pulse" : "bg-faint"} />
            </Lead>
            <span className="truncate">{job.name}</span>
            <span className={COUNT}>{job.enabled ? "On" : "Paused"}</span>
          </li>
        ))}
      </Section>
    </div>
  );
}

const AUDIT_ITEMS: [AuditFilter, string, string | undefined][] = [
  ["all", "Everything", undefined],
  ["unpublished", "Written here", "bg-dot-studio"],
  ["drifted", "Edited after install", "bg-dot-style"],
  ["broken", "Missing or broken links", "bg-dot-core"],
];

export function AuditNav({
  state,
  view,
  setView,
}: {
  state: UiState | undefined;
  view: View;
  setView: (patch: Partial<View>) => void;
}) {
  return (
    <nav aria-label="Show" className="px-2 pb-4">
      <Section title="Show">
        {AUDIT_ITEMS.map(([filter, label, dot]) => (
          <Item
            key={filter}
            active={view.audit === filter}
            onClick={() => setView({ audit: filter })}
            lead={dot === undefined ? undefined : <Dot className={dot} />}
            label={label}
            count={state === undefined ? undefined : needsLook(state.artifacts, filter).length}
          />
        ))}
      </Section>
    </nav>
  );
}

export function LockfileFooter({ state }: { state: UiState | undefined }) {
  let said = "Reading…";
  let healthy = true;
  if (state !== undefined) {
    const here = state.artifacts.filter(installed);
    const clean = here.filter((artifact) => artifact.state === "ok").length;
    healthy = clean === here.length;
    said =
      here.length === 0 ? "Nothing installed yet" : `${clean} of ${here.length} match the lockfile`;
  }
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t border-hairline px-4 text-[12px] text-muted">
      <CircleCheck
        aria-hidden
        className={cn("size-3.5", healthy ? "text-ok-ink" : "text-warn-ink")}
      />
      <span className="truncate tabular-nums">{said}</span>
    </div>
  );
}
