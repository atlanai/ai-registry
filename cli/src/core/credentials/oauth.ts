import { createHash, randomBytes } from "node:crypto";
import type { Credential, OAuthClient } from "#adapter/index.ts";
import { ERROR_CODE, signInFailed as failed, listenForCode } from "./loopback.ts";

const WAIT_MS = 5 * 60_000;
const MAX_BODY_BYTES = 1024 * 1024;

interface Server {
  issuer: string;
  authorization: string;
  token: string;
  /** RFC 9207: the callback names its issuer, so one from another server is told apart. */
  namesIssuer: boolean;
}

/** `waiting` shows the URL too, so a browser that `open` failed to start is not a dead end. */
export interface SignInPrompt {
  open(url: string): void;
  waiting(url: string, port: number): void;
}

/**
 * Signs in through the system browser as RFC 8252 has a native app do: a PKCE code returned
 * to a loopback port. `finish` stores the sign-in; the tab says it worked only once it has.
 */
export async function signInWithOAuth<T>(
  client: OAuthClient,
  prompt: SignInPrompt,
  signal: AbortSignal,
  finish: (credential: Credential) => Promise<T>,
): Promise<T> {
  const limited = AbortSignal.any([signal, AbortSignal.timeout(WAIT_MS)]);
  const server = await discover(trustedUrl(client.issuer, undefined, "address"), limited);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const callback = await listenForCode(
    { state, issuer: server.issuer, namesIssuer: server.namesIssuer },
    client.ports ?? [],
  );
  let signedIn = false;
  try {
    const url = authorizeUrl(server, client, callback.redirectUri, verifier, state);
    prompt.waiting(url, callback.port);
    prompt.open(url);
    const code = await Promise.race([callback.code, aborted(limited, signal)]);
    const credential = await exchange(
      server,
      {
        grant_type: "authorization_code",
        client_id: client.clientId,
        code,
        redirect_uri: callback.redirectUri,
        code_verifier: verifier,
      },
      limited,
    );
    const done = await finish(credential);
    signedIn = true;
    return done;
  } finally {
    await callback.close(signedIn);
  }
}

/** RFC 8414 metadata, at the well-known path inserted before the issuer's own path. */
async function discover(issuer: URL, signal: AbortSignal): Promise<Server> {
  const name = issuer.href.replace(/\/$/, "");
  const path = issuer.pathname.replace(/\/$/, "");
  let response: Response;
  try {
    response = await fetch(`${issuer.origin}/.well-known/oauth-authorization-server${path}`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal,
    });
  } catch (cause) {
    throw failed(`Cannot reach ${issuer.origin} to sign in.`, cause);
  }
  if (!response.ok) {
    throw failed(`${issuer.origin} has no sign-in metadata (HTTP ${response.status}).`);
  }
  const body = await readJson(response);
  // RFC 8414 3.3: metadata for any other issuer is not this server's, wherever it was served.
  if (typeof body.issuer !== "string" || body.issuer.replace(/\/$/, "") !== name) {
    throw failed(`${issuer.origin}'s sign-in metadata is for another server.`);
  }
  return {
    issuer: body.issuer,
    authorization: trustedUrl(body.authorization_endpoint, issuer.origin, "authorization endpoint")
      .href,
    token: trustedUrl(body.token_endpoint, issuer.origin, "token endpoint").href,
    namesIssuer: body.authorization_response_iss_parameter_supported === true,
  };
}

/** Stops at the cap, so a server that never stops sending cannot exhaust memory. */
async function readJson(response: Response): Promise<Record<string, unknown>> {
  const tooLarge = () => failed("The sign-in server's answer is too large.");
  if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (
    let read = await reader?.read();
    read !== undefined && !read.done;
    read = await reader?.read()
  ) {
    size += read.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader?.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(read.value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function trustedUrl(raw: unknown, origin: string | undefined, field: string): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw failed(`The sign-in server's ${field} is not a URL.`);
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw failed(`The sign-in server's ${field} is not https.`);
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw failed(`The sign-in server's ${field} carries credentials or a fragment.`);
  }
  // An endpoint elsewhere would receive the code or the verifier.
  if (origin !== undefined && url.origin !== origin) {
    throw failed(`The sign-in server's ${field} is not on ${origin}.`);
  }
  return url;
}

function authorizeUrl(
  server: Server,
  client: OAuthClient,
  redirectUri: string,
  verifier: string,
  state: string,
): string {
  const url = new URL(server.authorization);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirectUri,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
    ...(client.scopes === undefined ? {} : { scope: client.scopes.join(" ") }),
  })) {
    url.searchParams.set(key, value);
  }
  return url.href;
}

/** Rejects when `limited` aborts: the person canceled when `signal` did, else time ran out. */
function aborted(limited: AbortSignal, signal: AbortSignal): Promise<never> {
  const stopped = new Promise<never>((_, reject) => {
    const stop = () =>
      reject(
        signal.aborted
          ? failed("The sign-in was canceled.")
          : failed("The sign-in did not finish in time."),
      );
    if (limited.aborted) stop();
    else limited.addEventListener("abort", stop, { once: true });
  });
  stopped.catch(() => undefined);
  return stopped;
}

async function exchange(
  server: Server,
  form: Record<string, string>,
  signal: AbortSignal,
): Promise<Credential> {
  let response: Response;
  try {
    response = await fetch(server.token, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
      redirect: "error",
      signal,
    });
  } catch (cause) {
    throw failed("Cannot reach the sign-in server to finish signing in.", cause);
  }
  const body = await readJson(response);
  if (!response.ok) {
    const code = typeof body.error === "string" && ERROR_CODE.test(body.error) ? body.error : "";
    throw failed(
      `The sign-in server refused the sign-in (HTTP ${response.status}${code === "" ? "" : `, ${code}`}).`,
    );
  }
  return tokens(body);
}

function tokens(body: Record<string, unknown>): Credential {
  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw failed("The sign-in server returned no access token.");
  }
  if (typeof body.token_type === "string" && body.token_type.toLowerCase() !== "bearer") {
    throw failed("The sign-in server returned a token aireg cannot send.");
  }
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  const expiresIn = body.expires_in;
  const lasts = typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0;
  return {
    type: "bearer",
    accessToken,
    ...(refreshToken === "" ? {} : { refreshToken }),
    ...(lasts ? { expiresAtMs: Date.now() + expiresIn * 1000 } : {}),
  };
}
