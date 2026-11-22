import { useSyncExternalStore } from "react";

export interface Toast {
  id: number;
  tone: "info" | "success" | "error";
  title: string;
  detail: string | undefined;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function dismiss(id: number): void {
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

export function toast(tone: Toast["tone"], title: string, detail?: string): void {
  const id = nextId++;
  toasts = [...toasts.slice(-3), { id, tone, title, detail }];
  emit();
  setTimeout(() => dismiss(id), tone === "error" ? 8000 : 4000);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => toasts,
  );
}
