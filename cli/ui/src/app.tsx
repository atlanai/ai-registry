import * as Tabs from "@radix-ui/react-tabs";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { UiArtifact } from "../../src/cli/ui/protocol.ts";
import { RemoveDialog, SyncDialog } from "./components/action-dialogs.tsx";
import { AddDialog, type AddRequest } from "./components/add-dialog.tsx";
import { ArtifactStream } from "./components/artifact-list.tsx";
import { AuditView } from "./components/audit-view.tsx";
import type { PaletteAction } from "./components/command-palette.tsx";
import { DoctorDialog } from "./components/doctor-dialog.tsx";
import { ErrorNote } from "./components/error-note.tsx";
import { Header } from "./components/header.tsx";
import { Inspector } from "./components/inspector.tsx";
import { JobsView } from "./components/jobs-view.tsx";
import { SessionEnded } from "./components/session-ended.tsx";
import {
  ArtifactsNav,
  AuditNav,
  FilterBox,
  JobsNav,
  LockfileFooter,
  ModeSwitcher,
} from "./components/sidebar.tsx";
import { Toaster } from "./components/toaster.tsx";
import { Button } from "./components/ui/button.tsx";
import { useServerEvents } from "./lib/events.ts";
import { onSessionEnded, sessionEnded } from "./lib/rpc.ts";
import { useShortcuts } from "./lib/shortcuts.ts";
import { installSource, useUiState, visible } from "./lib/state.ts";
import { type Mode, useView } from "./lib/url-state.ts";

type Panel = "sync" | "doctor" | undefined;

// cmdk loads on the first ⌘K, keeping it out of the first paint.
const CommandPalette = lazy(() =>
  import("./components/command-palette.tsx").then((module) => ({ default: module.CommandPalette })),
);

function useEnded(): boolean {
  const [ended, setEnded] = useState(sessionEnded);
  useEffect(() => onSessionEnded(() => setEnded(true)), []);
  return ended;
}

export function App() {
  const client = useQueryClient();
  const ended = useEnded();
  const live = useServerEvents(client);
  const state = useUiState();
  const [view, setView] = useView();
  const [panel, setPanel] = useState<Panel>();
  const [add, setAdd] = useState<AddRequest>();
  const [removing, setRemoving] = useState<UiArtifact>();
  const [palette, setPalette] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const query = useDeferredValue(view.query);

  const all = state.data?.artifacts ?? [];
  const shown = useMemo(() => visible(all, { ...view, query }), [all, view, query]);
  // As the original did, the first row is inspected until another is chosen.
  const selected = all.find((artifact) => artifact.key === view.selected) ?? shown[0];
  const dialogOpen = palette || panel !== undefined || add !== undefined || removing !== undefined;

  useShortcuts({
    modal: dialogOpen || view.mode !== "artifacts",
    shown,
    view: { ...view, selected: selected?.key },
    setView,
    search,
    togglePalette: () => setPalette((open) => !open),
  });

  if (ended) return <SessionEnded />;

  const install = (artifact: UiArtifact) => {
    if (state.data !== undefined) setAdd(installSource(artifact, state.data));
  };
  const inspect = (key: string) =>
    setView({
      mode: "artifacts",
      selected: key,
      query: "",
      namespace: undefined,
      target: undefined,
    });
  const show = (name: string) => {
    setAdd(undefined);
    const found = all.find((artifact) => artifact.name === name && artifact.state !== "available");
    if (found !== undefined) inspect(found.key);
  };
  const onAction = (action: PaletteAction) => {
    if (action === "add") setAdd({ source: "", select: undefined });
    else setPanel(action);
  };

  return (
    <div className="flex h-full flex-col max-[1100px]:h-auto max-[1100px]:min-h-full">
      <Header
        state={state.data}
        live={live}
        syncing={
          state.data?.runs.some((run) => run.state === "running" && run.label === "sync") ?? false
        }
        onAdd={() => setAdd({ source: "", select: undefined })}
        onSync={() => setPanel("sync")}
        onDoctor={() => setPanel("doctor")}
        onPalette={() => setPalette(true)}
      />
      {state.data !== undefined && state.data.problems.length > 0 && (
        <div
          role="alert"
          className="flex items-center gap-3 border-b border-warn-line bg-warn-bg px-5 py-1.5 text-[12px] text-warn-ink"
        >
          <span className="min-w-0 flex-1 truncate">{state.data.problems.join(" · ")}</span>
          <Button className="px-2 py-0.5 text-[11px]" onClick={() => setPanel("doctor")}>
            Check this machine
          </Button>
        </div>
      )}
      <Tabs.Root
        value={view.mode}
        onValueChange={(mode) => setView({ mode: mode as Mode })}
        activationMode="manual"
        className="flex min-h-0 flex-1 overflow-hidden max-[1100px]:flex-col max-[1100px]:overflow-visible"
      >
        <aside className="flex h-full w-[240px] min-w-[240px] flex-col border-r border-hairline bg-canvas select-none max-[1100px]:max-h-[50vh] max-[1100px]:w-full">
          <ModeSwitcher state={state.data} />
          {view.mode === "artifacts" && (
            <FilterBox
              ref={search}
              value={view.query}
              onChange={(value) => setView({ query: value })}
            />
          )}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {view.mode === "artifacts" && (
              <ArtifactsNav state={state.data} view={view} setView={setView} />
            )}
            {view.mode === "jobs" && <JobsNav state={state.data} />}
            {view.mode === "audit" && <AuditNav state={state.data} view={view} setView={setView} />}
          </div>
          <LockfileFooter state={state.data} />
        </aside>
        <Tabs.Content
          value="artifacts"
          className="flex min-h-0 flex-1 overflow-hidden max-[1100px]:flex-col"
        >
          <ArtifactStream
            title={view.namespace ?? "All artifacts"}
            artifacts={shown}
            total={all.length}
            selected={selected?.key}
            onSelect={(key) => setView({ selected: key })}
            sort={view.sort}
            onSort={(sort) => setView({ sort })}
            loading={state.isPending}
          />
          <main
            aria-label="Inspector"
            className="flex h-full flex-1 flex-col overflow-y-auto bg-surface"
          >
            {state.isError ? (
              <div className="p-12">
                <ErrorNote error={state.error} />
                <Button className="mt-3" onClick={() => void state.refetch()}>
                  Try again
                </Button>
              </div>
            ) : (
              <Inspector artifact={selected} onInstall={install} onRemove={setRemoving} />
            )}
          </main>
        </Tabs.Content>
        <Tabs.Content value="jobs" className="flex min-h-0 flex-1 flex-col">
          <JobsView state={state.data} onSync={() => setPanel("sync")} />
        </Tabs.Content>
        <Tabs.Content value="audit" className="flex min-h-0 flex-1 flex-col">
          <AuditView state={state.data} filter={view.audit} onSelect={inspect} />
        </Tabs.Content>
      </Tabs.Root>
      <AddDialog request={add} onClose={() => setAdd(undefined)} onShow={show} />
      <RemoveDialog artifact={removing} onClose={() => setRemoving(undefined)} />
      <SyncDialog open={panel === "sync"} onClose={() => setPanel(undefined)} />
      <DoctorDialog open={panel === "doctor"} onClose={() => setPanel(undefined)} />
      {palette && (
        <Suspense fallback={null}>
          <CommandPalette
            open={palette}
            onOpenChange={setPalette}
            artifacts={all}
            onAction={onAction}
            onSelect={inspect}
          />
        </Suspense>
      )}
      <Toaster />
    </div>
  );
}
