import { replaceUserinfo } from "#adapter/text.ts";

export const KEYED_MARKER = "[REDACTED:keyed-field]";

/**
 * Matched as suffixes of the normalized key, so `GITHUB_TOKEN` and `apiKey` hit
 * while `input_tokens` does not. Bare `key` and `auth` are deliberately absent.
 */
export const KEYED_SUFFIXES: readonly string[] = [
  "apikey",
  "apisecret",
  "secretkey",
  "accesskey",
  "privatekey",
  "signingkey",
  "encryptionkey",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "passphrase",
  "token",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "bearertoken",
  "sessiontoken",
  "credential",
  "credentials",
  "authorization",
  "cookie",
  "accountnumber",
  "accountno",
  "acctnumber",
  "iban",
  "routingnumber",
  "ssn",
];

/** Keys that end in a suffix but name a count or a kind, never a value. */
const NOT_SECRETS: readonly string[] = [
  "inputtokens",
  "outputtokens",
  "totaltokens",
  "maxtokens",
  "tokentype",
  "tokenizer",
  "tokencount",
  "numtokens",
  "cachedtokens",
  "reasoningtokens",
  "completiontokens",
  "prompttokens",
];

export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (normalized === "") return false;
  if (NOT_SECRETS.some((safe) => normalized.endsWith(safe))) return false;
  return KEYED_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** `--password=x`, `--token x` or `-pass x`; a value starting with `-` is the next flag. */
const FLAG_FORM =
  /(--?(?:password|passwd|pass|token|api-?key|secret|access-?key)(?:=|\s+))(?!-)([^\s"']+)/gi;

/**
 * Like git's GIT_TRACE_REDACT: the scheme word is kept and the rest of the value up
 * to the line end or closing quote goes, since schemes such as Digest carry several parts.
 */
const AUTHORIZATION_HEADER = /(\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?)([^\r\n"']+)/gi;
const SCHEME_WORDS: ReadonlySet<string> = new Set([
  "basic",
  "bearer",
  "digest",
  "negotiate",
  "ntlm",
  "token",
  "apikey",
  "api-key",
  "aws4-hmac-sha256",
]);
const LEADING_SCHEME = new RegExp(`^((?:${[...SCHEME_WORDS].join("|")})\\s+)?(.*)$`, "is");

/** Outside a header a scheme word is often prose, so only a credential-length run after it goes. */
const BARE_SCHEME = /\b(basic|bearer|token)(\s+)([A-Za-z0-9._~+/-]{16,}=*)/gi;

/** Authorization values, `KEY=value` lines and `--password x` flags inside free text. */
export function redactKeyedText(text: string): { text: string; count: number } {
  let count = 0;
  let out = text.replace(AUTHORIZATION_HEADER, (whole, header: string, value: string) => {
    const [, scheme = "", credential = ""] = LEADING_SCHEME.exec(value) ?? [];
    if (credential.trim() === "" || isMarker(credential)) return whole;
    count += 1;
    return `${header}${scheme}${KEYED_MARKER}`;
  });
  out = out.replace(BARE_SCHEME, (_whole, scheme: string, space: string) => {
    count += 1;
    return `${scheme}${space}${KEYED_MARKER}`;
  });
  out = out.replace(
    /(^|[\s,;{(])([A-Za-z_][A-Za-z0-9_.-]{1,64})(\s*[=:]\s*)(["']?)([^\s"',;}\])]{4,})(\4)/g,
    (
      whole,
      lead: string,
      key: string,
      sep: string,
      quote: string,
      value: string,
      close: string,
    ) => {
      // A kept scheme word such as `Bearer` is not the secret; the marker after it is.
      if (!isSecretKey(key) || isMarker(value) || SCHEME_WORDS.has(value.toLowerCase())) {
        return whole;
      }
      count += 1;
      return `${lead}${key}${sep}${quote}${KEYED_MARKER}${close}`;
    },
  );
  out = out.replace(FLAG_FORM, (whole, flag: string, value: string) => {
    if (isMarker(value)) return whole;
    count += 1;
    return `${flag}${KEYED_MARKER}`;
  });
  return { text: out, count };
}

/** A value that is already a marker is never redacted again. */
function isMarker(value: string): boolean {
  return value.startsWith("[REDACTED:") || value.startsWith("[WITHHELD:");
}

/**
 * `scheme://user:password@host`: as OpenTelemetry's url.full rule asks, the whole
 * userinfo goes, since a token is often sent as the user name.
 */
export function maskUserinfo(text: string): string {
  return replaceUserinfo(text, (userinfo) =>
    userinfo === "" || isMarker(userinfo) ? undefined : KEYED_MARKER,
  );
}

/** Every free-text pass: what a string must go through before it reaches a log line. */
export function redactText(text: string): string {
  return maskUserinfo(redactKeyedText(text).text);
}

/** A throwing getter withholds the value: a log line must not be what takes a run down. */
export function redactKeyedValue(value: unknown): unknown {
  try {
    return walk(value, 0);
  } catch {
    return "[WITHHELD:scrubber-error]";
  }
}

const MAX_DEPTH = 16;

/** A secret key masks its whole subtree; every other string takes the free-text pass. */
function walk(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[WITHHELD:budget/depth]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSecretKey(key) ? KEYED_MARKER : walk(item, depth + 1);
    }
    return out;
  }
  return value;
}
