/** Runs aireg as the detached sender, which reads the queued events from stdin. */
export const TELEMETRY_FLAG = "--internal-telemetry";

/** Kept only once GitHub confirms every repository the event came from is public. */
export const NAMING_FIELDS = ["source", "artifacts", "query"] as const;

export const GITHUB_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type SourceType = "github" | "git" | "local" | "well-known" | "other";

export interface Named {
  sourceType: SourceType;
  kinds: string;
  source?: string;
  artifacts?: string;
}

/** Every event and field aireg can send. */
export type UsageEvent =
  | ({
      event: "install" | "remove";
      agents: string;
      global?: "1";
      trigger?: "add" | "install";
    } & Named)
  | ({ event: "publish" } & Named)
  | { event: "update"; artifactCount: string; updatedCount: string; global?: "1" }
  | { event: "search"; resultCount: string; kind?: string; query?: string }
  | { event: "sync"; registryCount: string; changedCount: string; failedCount: string };

/** An event as a command records it, with the repositories GitHub must confirm are public. */
export interface Queued {
  event: UsageEvent;
  github?: readonly string[] | undefined;
}
