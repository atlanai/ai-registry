// File spec sections 2.1 and 4.1.
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function digestHex(digest: string): string {
  return digest.replace(/^sha256:/, "");
}

/** `latest` names whichever version is newest, so it is never one of them. */
export function isVersion(value: string): boolean {
  return value !== "latest" && VERSION_PATTERN.test(value);
}

export function isDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}
