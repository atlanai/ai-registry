import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { type Fields, isRecord, textOf } from "#adapter/fields.ts";
import type { Credential } from "#adapter/index.ts";
import { quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { unknownKeys } from "#core/fields.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { OPEN_TO_OTHERS, PRIVATE_FILE, WRITABLE_BY_OTHERS } from "#core/fs/mode.ts";
import { isMissing } from "#core/fs/path.ts";
import { withLease } from "#core/lease/lease.ts";
import { credentialsPath, ensureHome } from "#core/store/paths.ts";
import { credentialOrigin } from "./origin.ts";

const VERSION = 1;
const ACCOUNT_PREFIX = "acc_";
const ACCOUNT_ID = new RegExp(`^${ACCOUNT_PREFIX}[a-zA-Z0-9_-]+$`);
const RFC_3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** A sign-in and the origin it was issued for, the only place aireg sends it. */
export interface StoredCredential {
  origin: string;
  credential: Credential;
}

export class CredentialStoreError extends AiregError {
  constructor(
    message: string,
    options: { cause?: unknown; code?: ErrorCode; hint?: string | undefined } = {},
  ) {
    super(message, {
      code: options.code ?? ErrorCode.Invalid,
      cause: options.cause,
      hint: options.hint,
    });
    this.name = "CredentialStoreError";
  }
}

/** In the one shape credentials.json keys accept. */
export function newAccountId(): string {
  return `${ACCOUNT_PREFIX}${randomUUID()}`;
}

/** From its own unfollowed stat; the store refuses and `doctor` reports by this one rule. */
export function fileExposure(info: Stats): string | undefined {
  if (info.isSymbolicLink()) return "is a symbolic link";
  if (!info.isFile()) return "is not a regular file";
  if (!POSIX) return undefined;
  const uid = typeof process.getuid === "function" ? process.getuid() : info.uid;
  if (info.uid !== uid) return "belongs to another user";
  if ((info.mode & OPEN_TO_OTHERS) !== 0) return "can be read by other users";
  return undefined;
}

/** Undefined means signed out. */
export async function readCredential(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredCredential | undefined> {
  assertAccountId(accountId);
  return (await load(credentialsPath(env))).get(accountId);
}

function assertAccountId(accountId: string): void {
  if (!ACCOUNT_ID.test(accountId)) {
    throw new CredentialStoreError(`${quoted(accountId)} is not an account id.`);
  }
}

async function load(path: string): Promise<Map<string, StoredCredential>> {
  const text = await readPrivate(path);
  return text === undefined ? new Map() : parse(text, path);
}

const EXPOSURE_HINT: Readonly<Record<string, (path: string) => string>> = {
  "is a symbolic link": () => "Remove it, then sign in again.",
  "can be read by other users": (path) => `Run \`chmod 600 ${path}\`, then sign in again.`,
};

/**
 * As ssh and libpq do, a token file someone else could read or swap is refused. Checked through
 * the open handle, so the file cannot change between the check and the read.
 */
async function readPrivate(path: string): Promise<string | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (POSIX ? constants.O_NOFOLLOW : 0));
  } catch (cause) {
    if (isMissing(cause)) return undefined;
    if ((cause as NodeJS.ErrnoException).code === "ELOOP")
      throw new CredentialStoreError(`${path} is a symbolic link.`, {
        hint: EXPOSURE_HINT["is a symbolic link"]?.(path),
      });
    throw new CredentialStoreError(`Could not read ${path}.`, { cause });
  }
  try {
    const exposed = fileExposure(await handle.stat());
    if (exposed !== undefined) {
      throw new CredentialStoreError(`${path} ${exposed}.`, {
        hint: EXPOSURE_HINT[exposed]?.(path),
      });
    }
    if (POSIX) {
      const home = dirname(path);
      if (((await stat(home)).mode & WRITABLE_BY_OTHERS) !== 0) {
        throw new CredentialStoreError(`${home} can be written by other users.`, {
          hint: `Run \`chmod 700 ${home}\`.`,
        });
      }
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function parse(text: string, path: string): Map<string, StoredCredential> {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw malformed(path, "it is not JSON");
  }
  if (!isRecord(document)) throw malformed(path, "it is not an object");
  if (document.version !== VERSION) throw malformed(path, `its version is not ${VERSION}`);
  if (unknownKeys(document, ["version", "credentials"]).length > 0) {
    throw malformed(path, "it holds more than version and credentials");
  }
  const { credentials } = document;
  if (!isRecord(credentials)) throw malformed(path, "its credentials are not an object");
  const entries = new Map<string, StoredCredential>();
  for (const [accountId, entry] of Object.entries(credentials)) {
    if (!ACCOUNT_ID.test(accountId)) throw malformed(path, "a key is not an account id");
    entries.set(
      accountId,
      decode(entry, (detail) => malformed(path, `the entry for ${accountId}: ${detail}`)),
    );
  }
  return entries;
}

/** POSIX permissions mean nothing on Windows, where the profile ACL protects the file. */
const POSIX = process.platform !== "win32";

// Never quotes the file, a value or a parse error: any of them can carry a token.
function malformed(path: string, detail: string): CredentialStoreError {
  return new CredentialStoreError(`${path} is not a valid credentials file: ${detail}.`, {
    hint: "Fix or remove it, then sign in again.",
  });
}

/** Reads one entry field by field; `fail` names the field, never its value. */
function decode(entry: unknown, fail: (detail: string) => Error): StoredCredential {
  if (!isRecord(entry)) throw fail("it is not an object");
  const text = (key: string) => {
    const value = textOf(entry[key]);
    if (value === undefined) throw fail(`its ${key} is not a non-empty string`);
    return value;
  };
  const only = (known: readonly string[]) => {
    if (unknownKeys(entry, known).length > 0) throw fail(`it takes only ${known.join(", ")}`);
  };
  const origin = text("origin");
  if (credentialOrigin(origin) !== origin) throw fail("its origin is not an origin");
  const type = text("type");
  if (type === "api_key") {
    only(["origin", "type", "header", "value"]);
    return { origin, credential: { type: "apiKey", header: text("header"), value: text("value") } };
  }
  if (type !== "bearer") throw fail("its type is not bearer or api_key");
  only(["origin", "type", "access_token", "refresh_token", "expires_at"]);
  const refreshToken = entry.refresh_token === undefined ? undefined : text("refresh_token");
  let expiresAtMs: number | undefined;
  if (entry.expires_at !== undefined) {
    const written = text("expires_at");
    expiresAtMs = RFC_3339.test(written) ? Date.parse(written) : Number.NaN;
    if (!Number.isFinite(expiresAtMs)) throw fail("its expires_at is not an RFC 3339 time");
  }
  return {
    origin,
    credential: {
      type: "bearer",
      accessToken: text("access_token"),
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    },
  };
}

/** An entry in the file is what signed in means, so no other record says so. */
export async function signedInAccounts(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReadonlySet<string>> {
  return new Set((await load(credentialsPath(env))).keys());
}

export async function saveCredential(
  accountId: string,
  stored: StoredCredential,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  assertAccountId(accountId);
  if (credentialOrigin(stored.origin) !== stored.origin) {
    throw new CredentialStoreError(`${quoted(stored.origin)} is not an origin.`);
  }
  await edit(env, (entries) => {
    entries.set(accountId, stored);
    return true;
  });
}

// One chain for the process, so its own writers queue here instead of polling the lease.
let pending: Promise<unknown> = Promise.resolve();

/** CLI and daemon both write the file, so each edit is a read-modify-write under its lease. */
function edit(
  env: NodeJS.ProcessEnv,
  change: (entries: Map<string, StoredCredential>) => boolean,
): Promise<boolean> {
  const path = credentialsPath(env);
  const next = pending.then(() => {
    ensureHome(env);
    return withLease({ scope: "user", lock: path }, { wait: true, env }, async () => {
      const entries = await load(path);
      const changed = change(entries);
      if (changed) await save(path, entries);
      return changed;
    });
  });
  // The caller sees the failure; the queue only orders the next edit.
  pending = next.catch(() => {});
  return next;
}

async function save(path: string, entries: ReadonlyMap<string, StoredCredential>): Promise<void> {
  const credentials = Object.fromEntries(
    [...entries].map(([accountId, stored]) => [accountId, encode(stored)]),
  );
  try {
    await writeAtomic(
      path,
      `${JSON.stringify({ version: VERSION, credentials }, null, 2)}\n`,
      PRIVATE_FILE,
    );
  } catch (cause) {
    throw new CredentialStoreError(`Could not write ${path}.`, { cause });
  }
}

function encode({ origin, credential }: StoredCredential): Fields {
  if (credential.type === "apiKey") {
    return { origin, type: "api_key", header: credential.header, value: credential.value };
  }
  return {
    origin,
    type: "bearer",
    access_token: credential.accessToken,
    ...(credential.refreshToken === undefined ? {} : { refresh_token: credential.refreshToken }),
    ...(credential.expiresAtMs === undefined
      ? {}
      : { expires_at: expiresAt(credential.expiresAtMs) }),
  };
}

function expiresAt(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

/** False when there was nothing to delete. */
export async function deleteCredential(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  assertAccountId(accountId);
  if (!(await load(credentialsPath(env))).has(accountId)) return false;
  return edit(env, (entries) => entries.delete(accountId));
}
