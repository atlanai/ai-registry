import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1000],
];

export function ago(atMs: number, nowMs = Date.now()): string {
  const delta = atMs - nowMs;
  for (const [unit, size] of UNITS) {
    if (Math.abs(delta) >= size || unit === "second") {
      return relative.format(Math.round(delta / size), unit);
    }
  }
  return "";
}

export function duration(fromMs: number, toMs: number): string {
  const seconds = Math.max(0, Math.round((toMs - fromMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** A job interval as the CLI prints it: whole hours as `1h`, else minutes. */
export function every(seconds: number | undefined): string {
  if (seconds === undefined) return "-";
  return seconds % 3600 === 0 ? `${seconds / 3600}h` : `${Math.round(seconds / 60)}m`;
}

/** True while focus is in a field, so single-key shortcuts never eat typing. */
export function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}
