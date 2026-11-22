import { type RefObject, useEffect, useRef } from "react";
import type { UiArtifact } from "../../../src/cli/ui/protocol.ts";
import type { View } from "./url-state.ts";
import { typing } from "./utils.ts";

interface Shortcuts {
  /** True while a dialog is open; list keys then stay out of its way. */
  modal: boolean;
  shown: UiArtifact[];
  view: View;
  setView: (patch: Partial<View>) => void;
  search: RefObject<HTMLInputElement | null>;
  togglePalette: () => void;
}

function listKey(key: string, { shown, view, setView, search }: Shortcuts): boolean {
  const at = shown.findIndex((artifact) => artifact.key === view.selected);
  const move = (to: number) => {
    const next = shown[Math.max(0, Math.min(shown.length - 1, to))];
    if (next !== undefined) setView({ selected: next.key });
  };
  switch (key) {
    case "/":
      search.current?.focus();
      return true;
    case "j":
    case "ArrowDown":
      move(at + 1);
      return true;
    case "k":
    case "ArrowUp":
      move(Math.max(0, at - 1));
      return true;
    case "Escape":
      setView({ selected: undefined });
      return view.selected !== undefined;
    default:
      return false;
  }
}

/** ⌘K anywhere; `/`, j/k and arrows only when focus is not in a field or dialog. */
export function useShortcuts(shortcuts: Shortcuts): void {
  const latest = useRef(shortcuts);
  latest.current = shortcuts;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const shortcuts = latest.current;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        shortcuts.togglePalette();
        return;
      }
      if (shortcuts.modal || typing(event.target) || event.metaKey || event.ctrlKey || event.altKey)
        return;
      if (listKey(event.key, shortcuts)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
