import { useCallback, useSyncExternalStore } from "react";

export type Mode = "artifacts" | "jobs" | "audit";
export type Sort = "name-asc" | "name-desc" | "namespace" | "version";
export type AuditFilter = "all" | "unpublished" | "drifted" | "broken";

export interface View {
  mode: Mode;
  selected: string | undefined;
  query: string;
  namespace: string | undefined;
  target: string | undefined;
  sort: Sort;
  audit: AuditFilter;
}

const MODES: readonly Mode[] = ["artifacts", "jobs", "audit"];
const SORTS: readonly Sort[] = ["name-asc", "name-desc", "namespace", "version"];
const AUDITS: readonly AuditFilter[] = ["all", "unpublished", "drifted", "broken"];

const listeners = new Set<() => void>();
let cached: string | undefined;
let cachedView: View;

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

function read(): View {
  const params = new URLSearchParams(location.search);
  return {
    mode: oneOf(params.get("m"), MODES, "artifacts"),
    selected: params.get("a") ?? undefined,
    query: params.get("q") ?? "",
    namespace: params.get("n") ?? undefined,
    target: params.get("t") ?? undefined,
    sort: oneOf(params.get("o"), SORTS, "name-asc"),
    audit: oneOf(params.get("f"), AUDITS, "all"),
  };
}

function snapshot(): View {
  if (location.search !== cached) {
    cached = location.search;
    cachedView = read();
  }
  return cachedView;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

const PARAM: Record<keyof View, string> = {
  mode: "m",
  selected: "a",
  query: "q",
  namespace: "n",
  target: "t",
  sort: "o",
  audit: "f",
};
const DEFAULTS: Partial<Record<keyof View, string>> = {
  mode: "artifacts",
  sort: "name-asc",
  audit: "all",
};

/** Mode, selection and filters live in the address, so reload and back keep them. */
export function useView(): [View, (patch: Partial<View>) => void] {
  const view = useSyncExternalStore(subscribe, snapshot);
  const update = useCallback((patch: Partial<View>) => {
    const params = new URLSearchParams(location.search);
    for (const [field, value] of Object.entries(patch) as [keyof View, string | undefined][]) {
      if (value === undefined || value === "" || value === DEFAULTS[field])
        params.delete(PARAM[field]);
      else params.set(PARAM[field], value);
    }
    const search = params.toString();
    history.replaceState(null, "", `${location.pathname}${search ? `?${search}` : ""}`);
    for (const listener of listeners) listener();
  }, []);
  return [view, update];
}
