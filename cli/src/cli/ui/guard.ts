import { timingSafeEqual } from "node:crypto";

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
  code: string;
  message: string;
}

/** Only what the page itself loads: the API answers nothing without the token. */
export const API_PREFIX = "/api/";

/**
 * Undefined lets a request through. Every check is here, before any route reads anything:
 * a page elsewhere can make a browser send a request here, but cannot read the token or
 * forge this server's name, its origin or a JSON body without a preflight this server
 * never answers.
 */
export function refusal(request: Incoming, bound: Bound): Refusal | undefined {
  const host = header(request, "host");
  // A page that rebinds its own name to 127.0.0.1 still sends that name.
  if (host === undefined || !hostsOf(bound.port).includes(host)) {
    return {
      status: 421,
      code: "wrong_host",
      message: "This server answers only to its own address.",
    };
  }
  if (!request.path.startsWith(API_PREFIX)) {
    return request.method === "GET" || request.method === "HEAD"
      ? undefined
      : { status: 405, code: "method", message: "The page is read-only." };
  }
  if (!holdsToken(header(request, "authorization"), bound.token)) {
    return { status: 401, code: "unauthorized", message: "The request carries no valid token." };
  }
  const site = header(request, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin") {
    return { status: 403, code: "cross_site", message: "Requests from other sites are refused." };
  }
  if (request.method === "GET") return undefined;
  if (request.method !== "POST") {
    return { status: 405, code: "method", message: "Use GET to read and POST to act." };
  }
  if (header(request, "origin") !== `http://${host}`) {
    return { status: 403, code: "cross_site", message: "Requests from other origins are refused." };
  }
  if (!/^application\/json\s*(;|$)/i.test(header(request, "content-type") ?? "")) {
    return { status: 415, code: "media_type", message: "Send the request as JSON." };
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

/** Compared in constant time, so the answer's timing says nothing about the token. */
function holdsToken(authorization: string | undefined, token: string): boolean {
  const given = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(authorization ?? "")?.[1];
  if (given === undefined) return false;
  const left = Buffer.from(given);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}
