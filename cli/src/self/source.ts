import { AiregError, ErrorCode } from "#core/errors.ts";
import {
  downloadArtifact,
  fetchManifest,
  type ManifestPlan,
  manifestPlan,
} from "#core/release/fetch.ts";
import { releaseStamp } from "#core/release/stamp.ts";

export interface ResolvedRelease {
  readonly version: string;
  /** Stated inline by the signed manifest. */
  readonly minimumVersion: string | undefined;
  readonly plan: ManifestPlan;
}

/** Said the same way wherever an unstamped build reaches for an update. */
function unstamped(): AiregError {
  return new AiregError("This build does not update itself.", {
    code: ErrorCode.Unavailable,
    hint: "Install a released build with the published installer, or pull and rebuild your source checkout.",
  });
}

/**
 * The signed channel manifest on the release server, and nothing else. A build
 * that cannot name its keyring has no signature to check, so it refuses.
 */
export async function resolveRelease(
  env: NodeJS.ProcessEnv = process.env,
  $fetch: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<ResolvedRelease> {
  const stamp = releaseStamp(env);
  if (stamp === undefined) throw unstamped();

  const manifest = await fetchManifest(stamp, $fetch, timeout(timeoutMs));
  return {
    version: manifest.version,
    minimumVersion: manifest.minimumVersion,
    plan: manifestPlan(stamp, manifest),
  };
}

/** Verified against the sha256 the signed manifest states for this artifact. */
export async function downloadRelease(
  release: ResolvedRelease,
  $fetch: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<Uint8Array> {
  return downloadArtifact(release.plan, $fetch, timeout(timeoutMs));
}

/** A standalone build is around 100 MB, worth saying before an unattended update spends it. */
export function downloadSize(release: ResolvedRelease): number | undefined {
  return release.plan.size;
}

export function describeSize(sizeBytes: number | undefined): string {
  return sizeBytes === undefined ? "" : ` (${Math.round(sizeBytes / (1024 * 1024))} MB download)`;
}

function timeout(timeoutMs: number | undefined): AbortSignal | undefined {
  return timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
}
