import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Dispatch, SiteClaim } from "#adapter/index.ts";
import { quoted } from "#adapter/text.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { hasOnly, namesOf } from "#core/fields.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { isSha256Hex, sha256Hex } from "#core/fs/hash.ts";
import { isMissing } from "#core/fs/path.ts";
import { NAME } from "#core/product.ts";

const INSTALL_RECORD_NAME = "install.json";
const INSTALL_RECORD_SCHEMA = `${NAME}-adapter-install.v1`;
const RECORD_KEYS = ["schema", "id", "sha256", "protocol", "dispatch"];

export interface AdapterInstallRecord {
  readonly id: string;
  readonly sha256: string;
  readonly protocol: number;
  readonly dispatch: Dispatch;
}

export function installRecordPath(modulePath: string): string {
  return join(dirname(modulePath), INSTALL_RECORD_NAME);
}

export async function readInstallRecord(
  modulePath: string,
): Promise<AdapterInstallRecord | undefined> {
  const path = installRecordPath(modulePath);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const record = parseInstallRecord(raw);
  if (record === undefined)
    throw new AiregError(`${path} is not a valid install record.`, { code: ErrorCode.Invalid });
  return record;
}

export async function writeInstallRecord(
  modulePath: string,
  record: AdapterInstallRecord,
): Promise<void> {
  await writeAtomic(installRecordPath(modulePath), `${JSON.stringify(formatRecord(record))}\n`);
}

/** Hash the module and refuse it when an install record disagrees. */
export async function assertInstallRecord(modulePath: string, id: string): Promise<void> {
  const record = await readInstallRecord(modulePath);
  if (record === undefined) return;
  if (record.id !== id) {
    throw new AiregError(`${modulePath} is recorded as ${quoted(record.id)}, not ${quoted(id)}.`, {
      code: ErrorCode.Integrity,
    });
  }
  const digest = sha256Hex(new Uint8Array(await readFile(modulePath)));
  if (digest !== record.sha256) {
    throw new AiregError(`${modulePath} does not match its install record.`, {
      code: ErrorCode.Integrity,
    });
  }
}

export function parseInstallRecord(raw: string): AdapterInstallRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!hasOnly(parsed, RECORD_KEYS)) return undefined;
  const doc = parsed;
  if (doc.schema !== INSTALL_RECORD_SCHEMA) return undefined;
  if (typeof doc.id !== "string" || typeof doc.sha256 !== "string") return undefined;
  if (typeof doc.protocol !== "number" || !Number.isInteger(doc.protocol)) return undefined;
  const dispatch = parseDispatch(doc.dispatch);
  if (dispatch === undefined) return undefined;
  if (!isSha256Hex(doc.sha256)) return undefined;
  return { id: doc.id, sha256: doc.sha256, protocol: doc.protocol, dispatch };
}

function formatRecord(record: AdapterInstallRecord): Record<string, unknown> {
  return {
    schema: INSTALL_RECORD_SCHEMA,
    id: record.id,
    sha256: record.sha256,
    protocol: record.protocol,
    dispatch: record.dispatch,
  };
}

export function parseDispatch(raw: unknown): Dispatch | undefined {
  if (!hasOnly(raw, ["hosts", "schemes", "paths", "sites"])) return undefined;
  const doc = raw;
  const hosts = namesOf(doc.hosts);
  const schemes = namesOf(doc.schemes);
  if (doc.hosts !== undefined && hosts === undefined) return undefined;
  if (doc.schemes !== undefined && schemes === undefined) return undefined;
  if (doc.paths !== undefined && typeof doc.paths !== "boolean") return undefined;
  const sites = doc.sites === undefined ? undefined : parseSites(doc.sites);
  if (doc.sites !== undefined && sites === undefined) return undefined;
  return {
    ...(hosts === undefined ? {} : { hosts }),
    ...(schemes === undefined ? {} : { schemes }),
    ...(doc.paths === true ? { paths: true } : {}),
    ...(sites === undefined ? {} : { sites }),
  };
}

function parseSites(raw: unknown): SiteClaim | undefined {
  if (!hasOnly(raw, ["schemes", "exceptHosts", "exceptSuffixes"])) return undefined;
  const schemes = namesOf(raw.schemes);
  const exceptHosts = namesOf(raw.exceptHosts);
  const exceptSuffixes = namesOf(raw.exceptSuffixes);
  if (schemes === undefined) return undefined;
  if (raw.exceptHosts !== undefined && exceptHosts === undefined) return undefined;
  if (raw.exceptSuffixes !== undefined && exceptSuffixes === undefined) return undefined;
  return {
    schemes,
    ...(exceptHosts === undefined ? {} : { exceptHosts }),
    ...(exceptSuffixes === undefined ? {} : { exceptSuffixes }),
  };
}
