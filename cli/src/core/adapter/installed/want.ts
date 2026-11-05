import { formatVersion, parseVersion } from "#adapter/semver.ts";
import { quoted } from "#adapter/text.ts";
import { isBuiltinAdapter } from "#core/adapter/load.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { isAdapterId } from "#core/release/origin.ts";

export interface AdapterWant {
  readonly id: string;
  /** Exact SemVer when the caller pinned `@1.4.0`; otherwise the channel head. */
  readonly version: string | undefined;
}

export function parseAdapterId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!isAdapterId(id)) {
    throw new AiregError(`${quoted(raw.trim())} is not an adapter id.`, {
      code: ErrorCode.Usage,
      hint: "Use lowercase letters, digits and hyphens, like acme.",
    });
  }
  return id;
}

/** Adapters installed without asking; any other id needs the person's consent. */
const TRUSTED = ["atlan"] as const;

export function isTrusted(id: string): boolean {
  return (TRUSTED as readonly string[]).includes(id);
}

export function parseWant(raw: string): AdapterWant {
  const trimmed = raw.trim();
  const at = trimmed.lastIndexOf("@");
  const id = parseAdapterId(at <= 0 ? trimmed : trimmed.slice(0, at));
  const version = at <= 0 ? undefined : trimmed.slice(at + 1);
  if (isBuiltinAdapter(id)) {
    throw new AiregError(`${quoted(id)} is built into aireg, so it cannot be installed.`, {
      code: ErrorCode.Usage,
      hint: "Install another adapter, or choose a new id.",
    });
  }
  if (version === undefined) return { id, version };
  const parsed = parseVersion(version);
  if (parsed === undefined || formatVersion(parsed) !== version) {
    throw new AiregError(`${quoted(version)} is not an exact version.`, {
      code: ErrorCode.Usage,
      hint: "Pin it like acme@1.4.0, not acme@v1.4.0.",
    });
  }
  return { id, version };
}
