/** One artifact version that ran. */
export interface UsageArtifact {
  /** The registry's alias. */
  registry: string;
  /** `<namespace>/<kind>/<name>@<version>`. */
  ref: string;
  runs: number;
  /** Of those runs, how many you started yourself. */
  byYou: number;
  /** The targets it ran in, by id. */
  targets: string[];
  /** ISO 8601. */
  last: string;
}

export interface UsageSharing {
  registry: string;
  otlp: string;
  /** The name you chose; `null` when the registry gets a pseudonym. */
  as: string | null;
}

export interface UsageReport {
  days: number;
  artifacts: UsageArtifact[];
  sharing: UsageSharing[];
}

export interface UsageShareResult {
  registry: string;
  otlp: string;
  /** `false` once sharing is turned off. */
  sharing: boolean;
  reporter: "pseudonym" | "name";
  as: string | null;
}

export interface UsageShareList {
  sharing: UsageSharing[];
}

export interface UsageSent {
  registry: string;
  otlp: string;
  sent: number;
  pending: number;
  /** Why nothing more was sent; `null` when everything went. */
  stopped: string | null;
}

export interface UsageSendResult {
  registries: UsageSent[];
}
