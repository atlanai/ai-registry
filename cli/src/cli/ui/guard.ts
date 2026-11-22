import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface Incoming {
  method: string;
  path: string;
  /** Lowercased names, as `node:http` gives them. */
  headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface Bound {
  port: number;
  /** Minted per launch; the page reads it from the URL's fragment, which no request carries. */
  token: string;
}

export interface Refusal {
  status: number;
  message: string;
}

export const RPC_PATH = "/rpc";
export const EVENTS_PATH = "/events";
export const SESSION_PATH = "/session";
export const HEALTH_PATH = "/health";

/** Cookies ignore the port, so each server names its own. */
export function cookieName(port: number): string {
  return `aireg-ui-${port}`;
}

/** Derived, so the launch token itself never sits in a cookie jar. */
export function sessionValue(token: string): string {
  return createHmac("sha256", token).update("aireg ui session").digest("base64url");
}

/** What `/health` answers, so a launcher can tell this server from another on the port. */
export function instanceId(token: string): string {
  return createHash("sha256").update(`aireg ui instance\u0000${token}`).digest("hex").slice(0, 32);
}

/**
 * Undefined lets a request through. A page elsewhere can make a browser send a request here,
 * but cannot read the token, forge this server's name or origin, or send JSON without a
 * preflight this server never answers.
 */
export function refusal(request: Incoming, bound: Bound): Refusal | undefined {
  const host = header(request, "host");
  // A page that rebinds its own name to 127.0.0.1 still sends that name.
  if (host === undefined || !hostsOf(bound.port).includes(host)) {
    return {
      status: 421,
      message: "This server answers only to its own address.",
    };
  }
  const { method, path } = request;
  const gated = path === RPC_PATH || path === EVENTS_PATH || path === SESSION_PATH;
  if (!gated) {
    return method === "GET" || method === "HEAD"
      ? undefined
      : { status: 405, message: "The page is read-only." };
  }
  if (path !== SESSION_PATH && !authorized(request, bound)) {
    return { status: 401, message: "The request carries no valid session." };
  }
  const site = header(request, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin") {
    return { status: 403, message: "Requests from other sites are refused." };
  }
  if (path === EVENTS_PATH) {
    return method === "GET" ? undefined : { status: 405, message: "Use GET." };
  }
  if (method !== "POST") return { status: 405, message: "Use POST." };
  if (header(request, "origin") !== `http://${host}`) {
    return { status: 403, message: "Requests from other origins are refused." };
  }
  if (!/^application\/json\s*(;|$)/i.test(header(request, "content-type") ?? "")) {
    return { status: 415, message: "Send the request as JSON." };
  }
  return undefined;
}

/** Compared in constant time, so the answer's timing says nothing about the secret. */
export function same(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authorized(request: Incoming, bound: Bound): boolean {
  const bearer = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(header(request, "authorization") ?? "");
  if (bearer !== null) return same(bearer[1], bound.token);
  return same(
    cookieOf(header(request, "cookie"), cookieName(bound.port)),
    sessionValue(bound.token),
  );
}

function cookieOf(cookies: string | undefined, name: string): string | undefined {
  for (const part of (cookies ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

function hostsOf(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

function header(request: Incoming, name: string): string | undefined {
  const value = request.headers[name];
  // node:http keeps the first of a repeated Host, Origin or Authorization; others arrive as lists.
  return typeof value === "string" ? value : undefined;
}
