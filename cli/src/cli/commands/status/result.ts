import type { ArtifactKind } from "#adapter/kinds.ts";
import type { LinkState, State } from "#core/plan/status.ts";
import type { Scope } from "#core/store/paths.ts";

export interface StatusResult {
  scope: Scope;
  artifacts: StatusArtifact[];
  /** Installed both here and in the user scope; always empty for `-g`. */
  shadowed: string[];
  unmanaged: UnmanagedArtifact[];
  dangling: DanglingEntry[];
}

interface StatusArtifact {
  name: string;
  /** `dangling` is what the table calls `replaced`. */
  state: State;
  /** Why it is not `ok`, starting with the folder. */
  detail?: string;
  /** By target id. */
  targets: Record<string, LinkState>;
  blocked?: true;
  taken?: true;
  /** `targets` by the ids aireg 0.1 used. */
  harnesses: Record<string, LinkState>;
  neededBy?: string[];
  needsApproval?: Approval[];
}

/** A command a person runs before a target loads the artifact; aireg never runs it. */
export interface Approval {
  target: string;
  harness: string;
  run: string;
}

interface UnmanagedArtifact {
  name: string;
  kind: ArtifactKind;
  targets: string[];
  path: string;
  harnesses: string[];
}

/** As aireg 0.1 printed it: `target` is what the link names, and `harness` its folder. */
interface DanglingEntry {
  path: string;
  target: string;
  harness: string;
}
