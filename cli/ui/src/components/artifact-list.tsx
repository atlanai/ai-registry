import * as Menu from "@radix-ui/react-dropdown-menu";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef } from "react";
import type { UiArtifact } from "../../../src/cli/ui/protocol.ts";
import { stateLabel } from "../lib/state.ts";
import type { Sort } from "../lib/url-state.ts";
import { cn } from "../lib/utils.ts";

const SORTS: [Sort, string][] = [
  ["name-asc", "A → Z"],
  ["name-desc", "Z → A"],
  ["namespace", "Namespace"],
  ["version", "Version"],
];

function SortMenu({ sort, onSort }: { sort: Sort; onSort: (sort: Sort) => void }) {
  const label = SORTS.find(([value]) => value === sort)?.[1] ?? "A → Z";
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Sort artifacts"
        className="flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-[12.5px] text-muted transition-colors hover:bg-subtle hover:text-ink"
      >
        {label}
        <ChevronDown aria-hidden className="size-3.5 text-dim" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="end"
          sideOffset={4}
          className="animate-fade-in z-50 min-w-32 rounded-lg border border-line bg-surface p-1 shadow-popover"
        >
          <Menu.RadioGroup value={sort} onValueChange={(value) => onSort(value as Sort)}>
            {SORTS.map(([value, text]) => (
              <Menu.RadioItem
                key={value}
                value={value}
                className="cursor-pointer rounded-md px-2.5 py-1.5 text-[12px] text-ink-2 outline-none data-[highlighted]:bg-subtle data-[highlighted]:text-ink data-[state=checked]:font-semibold data-[state=checked]:text-ink"
              >
                {text}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

const STATE_DOT: Record<string, string> = {
  ok: "bg-pulse",
  available: "bg-faint",
  edited: "bg-dot-studio",
  missing: "bg-bad-ink",
  dangling: "bg-bad-ink",
  failed: "bg-bad-ink",
};

function Row({ artifact, active }: { artifact: UiArtifact; active: boolean }) {
  return (
    <div
      className={cn(
        "group relative flex cursor-pointer flex-col gap-0.5 rounded-md px-3 py-2.5 transition-[background-color] duration-100",
        active
          ? "bg-[rgb(15_23_42/0.05)] before:absolute before:top-2.5 before:bottom-2.5 before:left-0 before:w-[2px] before:rounded-full before:bg-ink"
          : "hover:bg-subtle",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[13px] font-medium text-ink">{artifact.name}</span>
        <span className="shrink-0 font-mono text-[11px] text-dim">
          {artifact.installedVersion || artifact.version || ""}
        </span>
      </div>
      <p className="truncate text-[12.5px] leading-5 text-muted">
        {artifact.description || "No description"}
      </p>
      <div className="flex h-5 items-center gap-2 text-[11.5px] text-dim">
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", STATE_DOT[artifact.state] ?? "bg-dot-core")}
          />
          {stateLabel(artifact.state)}
        </span>
        {artifact.namespace !== "" && (
          <>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span className="shrink-0">{artifact.namespace}</span>
          </>
        )}
        {artifact.harnesses.length > 0 && (
          <span
            className={cn(
              "min-w-0 truncate transition-opacity duration-100 before:mr-2 before:text-faint before:content-['·']",
              active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
          >
            {artifact.harnesses.join(", ")}
          </span>
        )}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading artifacts"
      className="flex flex-col gap-1 p-2"
    >
      {[72, 56, 64, 48, 60, 52].map((width) => (
        <div key={width} className="flex flex-col gap-2 px-3 py-3">
          <div className="h-3 rounded bg-subtle" style={{ width: `${width}%` }} />
          <div className="h-2.5 w-11/12 rounded bg-subtle/70" />
          <div className="h-2.5 w-1/3 rounded bg-subtle/70" />
        </div>
      ))}
    </div>
  );
}

function Empty({ nothingAtAll }: { nothingAtAll: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-16 text-center">
      <p className="text-[13px] font-medium text-ink">
        {nothingAtAll ? "No artifacts yet" : "No matches"}
      </p>
      <p className="max-w-64 text-[12.5px] leading-5 text-muted">
        {nothingAtAll ? (
          <>
            Add a registry with <code className="font-mono text-[12px]">aireg registry add</code>,
            or use Add to install from a repository or folder.
          </>
        ) : (
          "Try a different filter, or clear it to see everything."
        )}
      </p>
    </div>
  );
}

function List({
  artifacts,
  selected,
  onSelect,
}: {
  artifacts: UiArtifact[];
  selected: string | undefined;
  onSelect: (key: string) => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: artifacts.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 76,
    overscan: 10,
    paddingStart: 8,
    paddingEnd: 8,
  });
  const index = artifacts.findIndex((artifact) => artifact.key === selected);
  useEffect(() => {
    if (index >= 0) virtual.scrollToIndex(index, { align: "auto" });
  }, [index, virtual]);
  return (
    <div
      ref={parent}
      role="listbox"
      aria-label="Artifacts"
      tabIndex={0}
      aria-activedescendant={index >= 0 ? `row-${index}` : undefined}
      className="min-h-0 flex-1 overflow-y-auto px-2 focus-visible:outline-offset-[-2px]"
    >
      <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map((item) => {
          const artifact = artifacts[item.index];
          if (artifact === undefined) return null;
          return (
            <div
              key={artifact.key}
              id={`row-${item.index}`}
              role="option"
              tabIndex={-1}
              aria-selected={artifact.key === selected}
              data-index={item.index}
              ref={virtual.measureElement}
              onClick={() => onSelect(artifact.key)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSelect(artifact.key);
              }}
              className="absolute inset-x-0 top-0 pb-px"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <Row artifact={artifact} active={artifact.key === selected} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ArtifactStream({
  title,
  artifacts,
  total,
  selected,
  onSelect,
  sort,
  onSort,
  loading,
}: {
  title: string;
  artifacts: UiArtifact[];
  total: number;
  selected: string | undefined;
  onSelect: (key: string) => void;
  sort: Sort;
  onSort: (sort: Sort) => void;
  loading: boolean;
}) {
  let body = <List artifacts={artifacts} selected={selected} onSelect={onSelect} />;
  if (loading) {
    body = <Skeleton />;
  } else if (artifacts.length === 0) {
    body = <Empty nothingAtAll={total === 0} />;
  }
  return (
    <section className="flex h-full w-[380px] min-w-[380px] flex-col overflow-hidden border-r border-hairline bg-surface max-[1100px]:w-full max-[1100px]:min-w-0">
      <div className="flex h-11 min-h-11 items-center justify-between border-b border-hairline pr-2 pl-5 select-none">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-[13px] font-semibold text-ink">{title}</h2>
          <span className="text-[12.5px] text-dim tabular-nums">{artifacts.length}</span>
        </div>
        <SortMenu sort={sort} onSort={onSort} />
      </div>
      {body}
    </section>
  );
}
