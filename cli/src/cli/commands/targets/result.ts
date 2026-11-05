import type { EarlierTarget, Target } from "#core/target/contract.ts";
import type { DetectionRule } from "#core/target/detect.ts";
import type { SkippedFile } from "#core/target/load.ts";

/** `aireg targets`: every target, found or not. */
export interface TargetsList {
  targets: Listed[];
  /** The aireg 0.1 list, by the ids that version knows and with `kind`. */
  harnesses: EarlierListed[];
  skipped: SkippedFile[];
  /** Files aireg uses but would have you change. */
  warnings: FileWarnings[];
}

interface Listed {
  name: string;
  aliases: string[];
  displayName: string;
  shared: boolean;
  detected: boolean;
  by?: DetectionRule;
  /** `built-in`, or the path of the file that defines it. */
  origin: string;
}

interface EarlierListed {
  name: string;
  displayName: string;
  kind: EarlierTarget["kind"];
  shared: boolean;
  detected: boolean;
  by?: DetectionRule;
  origin: string;
}

interface FileWarnings {
  path: string;
  warnings: string[];
}

/** `aireg targets show`: as resolved, and as aireg 0.1 named it. */
export interface TargetShown {
  target: Omit<Target, "category">;
  harness: Omit<EarlierTarget, "category" | "aliases">;
}

/** `aireg targets check`. */
export interface TargetCheck {
  path: string;
  /** Absent when the file defines no usable target. */
  id?: string;
  problems: string[];
  warnings: string[];
}
