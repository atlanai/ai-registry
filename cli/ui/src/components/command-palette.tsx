import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { Activity, Plus, RefreshCw, Search } from "lucide-react";
import type { ReactNode } from "react";
import type { UiArtifact } from "../../../src/cli/ui/protocol.ts";
import { namespaceOf } from "../lib/state.ts";
import { NamespacePill } from "./namespace-pill.tsx";

export type PaletteAction = "add" | "sync" | "doctor";

const ACTIONS: [PaletteAction, string, ReactNode][] = [
  ["add", "Add artifacts", <Plus key="add" />],
  ["sync", "Sync now", <RefreshCw key="sync" />],
  ["doctor", "Check this machine", <Activity key="doctor" />],
];

const ITEM =
  "flex cursor-pointer items-center justify-between gap-2.5 rounded-[7px] px-3 py-[9px] text-[13px] text-ink-2 transition-all duration-100 data-[selected=true]:bg-subtle data-[selected=true]:text-ink [&_svg]:size-3.5 [&_svg]:text-dim";
const GROUP =
  "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-muted [&_[cmdk-group-heading]]:uppercase";
const MINI = "mr-1 rounded-[3px] border border-hairline bg-surface px-[5px] py-px font-mono";

export function CommandPalette({
  open,
  onOpenChange,
  artifacts,
  onAction,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifacts: UiArtifact[];
  onAction: (action: PaletteAction) => void;
  onSelect: (key: string) => void;
}) {
  const run = (act: () => void) => {
    onOpenChange(false);
    act();
  };
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="animate-fade-in fixed inset-0 z-[100] bg-[rgb(15_23_42/0.35)] backdrop-blur-[6px]" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="animate-modal fixed top-[12vh] left-1/2 z-[101] flex w-[min(600px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-popover"
        >
          <DialogPrimitive.Title className="sr-only">Find an artifact</DialogPrimitive.Title>
          <Command loop label="Find an artifact">
            <div className="flex items-center gap-3 border-b border-hairline px-[18px] py-3.5">
              <Search className="size-4 text-dim" />
              <Command.Input
                autoFocus
                placeholder="Type an artifact or namespace to jump to it"
                className="flex-1 border-0 bg-transparent text-[15px] text-ink outline-none placeholder:text-dim"
              />
              <kbd className="rounded border border-[rgb(15_23_42/0.08)] bg-[rgb(15_23_42/0.05)] px-[5px] py-px font-mono text-[10px] text-muted">
                ESC
              </kbd>
            </div>
            <Command.List className="max-h-[360px] overflow-y-auto p-2">
              <Command.Empty className="p-4 text-center text-[12px] text-muted">
                Nothing matches.
              </Command.Empty>
              <Command.Group heading="Artifacts" className={GROUP}>
                {artifacts.slice(0, 200).map((artifact) => (
                  <Command.Item
                    key={artifact.key}
                    value={`${artifact.name} ${namespaceOf(artifact)} ${artifact.key}`}
                    onSelect={() => run(() => onSelect(artifact.key))}
                    className={ITEM}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <NamespacePill namespace={namespaceOf(artifact)} />
                      <span className="truncate font-[550] text-ink">{artifact.name}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[10.5px] text-dim">
                      {artifact.version ? `v${artifact.version}` : artifact.kind}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading="Actions" className={GROUP}>
                {ACTIONS.map(([action, label, icon]) => (
                  <Command.Item
                    key={action}
                    onSelect={() => run(() => onAction(action))}
                    className={ITEM}
                  >
                    <span className="flex items-center gap-2.5">
                      {icon}
                      <span className="font-[550] text-ink">{label}</span>
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
          <div className="flex items-center gap-4 border-t border-hairline bg-subtle px-[18px] py-[9px] text-[11px] text-muted">
            <span>
              <kbd className={MINI}>↑</kbd>
              <kbd className={MINI}>↓</kbd> Navigate
            </span>
            <span>
              <kbd className={MINI}>↵</kbd> Select
            </span>
            <span>
              <kbd className={MINI}>ESC</kbd> Close
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
