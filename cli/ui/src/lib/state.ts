import { useQuery } from "@tanstack/react-query";
import type { UiArtifact, UiState } from "../../../src/cli/ui/protocol.ts";
import { rpc } from "./rpc.ts";
import type { AuditFilter, Sort, View } from "./url-state.ts";

/** Refetched only when the server says `state` or after an action; never polled. */
export function useUiState() {
  return useQuery({
    queryKey: ["state"],
    queryFn: () => rpc("state.snapshot", {}),
    staleTime: Infinity,
  });
}

export function installed(artifact: UiArtifact): boolean {
  return artifact.state !== "available";
}

/** The namespace a row is filed under; local work has none, so its registry stands in. */
export function namespaceOf(artifact: UiArtifact): string {
  return artifact.namespace || artifact.registry;
}

function compare(sort: Sort): (a: UiArtifact, b: UiArtifact) => number {
  switch (sort) {
    case "name-asc":
      return (a, b) => a.name.localeCompare(b.name);
    case "name-desc":
      return (a, b) => b.name.localeCompare(a.name);
    case "namespace":
      return (a, b) => namespaceOf(a).localeCompare(namespaceOf(b)) || a.name.localeCompare(b.name);
    case "version":
      return (a, b) =>
        b.version.localeCompare(a.version, undefined, { numeric: true }) ||
        a.name.localeCompare(b.name);
  }
}

export function visible(artifacts: readonly UiArtifact[], view: View): UiArtifact[] {
  const query = view.query.trim().toLowerCase();
  return artifacts
    .filter(
      (artifact) =>
        (view.namespace === undefined || namespaceOf(artifact) === view.namespace) &&
        (view.target === undefined || artifact.harnesses.includes(view.target)) &&
        (query === "" ||
          [artifact.name, artifact.namespace, artifact.description, artifact.registry]
            .join(" ")
            .toLowerCase()
            .includes(query)),
    )
    .sort(compare(view.sort));
}

export function counts(values: readonly string[]): [string, number][] {
  const tally = new Map<string, number>();
  for (const value of values) if (value) tally.set(value, (tally.get(value) ?? 0) + 1);
  return [...tally].sort((a, b) => a[0].localeCompare(b[0]));
}

const flag = (state: UiState) => (state.scope === "project" ? "" : " -g");

/** What a person may need to act on, and the command that settles each, in the console's words. */
const NEEDS_LOOK: Record<string, (artifact: UiArtifact, state: UiState) => string> = {
  edited: (a, s) =>
    `aireg sync${flag(s)} compares it with ${a.registry}; publish it to keep your edit`,
  missing: (_, s) => `aireg install${flag(s)} links it again`,
  dangling: (_, s) => `aireg status${flag(s)} names the link to remove`,
  failed: (a, s) => `aireg status${flag(s)} shows why ${a.registry} would not serve it`,
  unpublished: () => "aireg publish <folder> --to <registry>/<namespace>",
  duplicate: () => "An installed artifact has this name; remove or rename this copy",
};

export function nextStep(artifact: UiArtifact, state: UiState): string | undefined {
  return NEEDS_LOOK[artifact.state]?.(artifact, state);
}

const LOOK_FILTERS: Record<AuditFilter, (artifact: UiArtifact) => boolean> = {
  all: () => true,
  unpublished: (a) => a.state === "unpublished",
  drifted: (a) => a.state === "edited",
  broken: (a) => a.state === "missing" || a.state === "dangling",
};

export function needsLook(artifacts: readonly UiArtifact[], filter: AuditFilter): UiArtifact[] {
  return artifacts.filter((a) => a.state in NEEDS_LOOK && LOOK_FILTERS[filter](a));
}

/** Each state's tone and what it means, in the console's words. */
export function stateText(artifact: UiArtifact): ["clean" | "drifted" | "pending", string] {
  const said: Record<string, ["clean" | "drifted" | "pending", string]> = {
    ok: ["clean", "Installed, matches the lockfile"],
    available: [
      "pending",
      `Not installed; ${artifact.registry} serves ${artifact.version || "it"}`,
    ],
    authored: ["clean", "Written here and published"],
    edited: ["drifted", "Edited after it was installed"],
    missing: ["drifted", "A target link is missing"],
    dangling: ["drifted", "A link points somewhere else"],
    failed: ["drifted", "Its registry would not serve it"],
    unpublished: ["pending", "Written here, in no registry yet"],
    duplicate: ["pending", "Another copy of an installed artifact"],
    imported: ["clean", "Written here; a job carries it to its registry"],
    pending: ["pending", "Published; run aireg install to track it"],
  };
  return said[artifact.state] ?? ["pending", artifact.state];
}

/** The source and selection `install.plan` takes for a listed artifact. */
export function installSource(
  artifact: UiArtifact,
  state: UiState,
): { source: string; select: string } {
  const registry = state.registries.find((candidate) => candidate.name === artifact.registry);
  return { source: registry?.address ?? artifact.registry, select: artifact.name };
}

/** A state as a person reads it in a list. */
export function stateLabel(state: string): string {
  if (state === "ok") return "Installed";
  if (state === "available") return "Not installed";
  return state.charAt(0).toUpperCase() + state.slice(1);
}
