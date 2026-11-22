import { describe, expect, test } from "vitest";
import { cookieName, type Incoming, refusal, sessionValue } from "./guard.ts";

const bound = { port: 4000, token: "a".repeat(43) };
const auth = `Bearer ${bound.token}`;
const cookie = `${cookieName(4000)}=${sessionValue(bound.token)}`;

function request(over: Partial<Incoming> & { headers?: Incoming["headers"] }): Incoming {
  return {
    method: "GET",
    path: "/events",
    ...over,
    headers: { host: "127.0.0.1:4000", authorization: auth, ...over.headers },
  };
}

const post = (headers: Incoming["headers"], path = "/rpc") =>
  request({
    method: "POST",
    path,
    headers: { origin: "http://127.0.0.1:4000", "content-type": "application/json", ...headers },
  });

describe("a request to aireg ui", () => {
  test("passes with its own host, a session, and for a call its own origin and JSON", () => {
    expect(refusal(request({}), bound)).toBeUndefined();
    expect(refusal(post({}), bound)).toBeUndefined();
    expect(refusal(post({ authorization: undefined, cookie }), bound)).toBeUndefined();
    expect(
      refusal(post({ host: "localhost:4000", origin: "http://localhost:4000" }), bound),
    ).toBeUndefined();
  });

  test("is refused under any other host name, as a rebound one would send", () => {
    expect(refusal(request({ headers: { host: "evil.example:4000" } }), bound)?.status).toBe(421);
    expect(refusal(request({ headers: { host: "127.0.0.1:4001" } }), bound)?.status).toBe(421);
    expect(refusal(request({ path: "/", headers: { host: undefined } }), bound)?.status).toBe(421);
  });

  test("reads nothing without the token or the session it buys", () => {
    const without = { authorization: undefined };
    expect(refusal(request({ headers: without }), bound)?.status).toBe(401);
    expect(refusal(request({ headers: { authorization: "Bearer wrong" } }), bound)?.status).toBe(
      401,
    );
    expect(refusal(request({ headers: { ...without, cookie: `${cookie}x` } }), bound)?.status).toBe(
      401,
    );
    // Cookies ignore the port, so another server's session is not this one's.
    expect(
      refusal(
        request({
          headers: { ...without, cookie: `${cookieName(4001)}=${sessionValue(bound.token)}` },
        }),
        bound,
      )?.status,
    ).toBe(401);
    expect(refusal(post({ authorization: undefined }), bound)?.status).toBe(401);
  });

  test("lets the page trade its token for a session, as the page itself only", () => {
    const fresh = { authorization: undefined };
    expect(refusal(post(fresh, "/session"), bound)).toBeUndefined();
    expect(
      refusal(post({ ...fresh, origin: "https://evil.example" }, "/session"), bound)?.status,
    ).toBe(403);
    expect(
      refusal(post({ ...fresh, "content-type": "text/plain" }, "/session"), bound)?.status,
    ).toBe(415);
  });

  test("serves the page and its health to anyone at its address, and only to read", () => {
    const without = { authorization: undefined };
    expect(refusal(request({ path: "/", headers: without }), bound)).toBeUndefined();
    expect(refusal(request({ path: "/health", headers: without }), bound)).toBeUndefined();
    expect(refusal(request({ method: "POST", path: "/" }), bound)?.status).toBe(405);
  });

  test("refuses a call from another origin, even one holding the token", () => {
    expect(refusal(post({ origin: "https://evil.example" }), bound)?.status).toBe(403);
    expect(refusal(post({ origin: undefined }), bound)?.status).toBe(403);
    expect(refusal(post({ "sec-fetch-site": "cross-site" }), bound)?.status).toBe(403);
    expect(refusal(request({ headers: { "sec-fetch-site": "cross-site" } }), bound)?.status).toBe(
      403,
    );
  });

  test("takes a call only as JSON, which a form on another site cannot send", () => {
    expect(refusal(post({ "content-type": "text/plain" }), bound)?.status).toBe(415);
    expect(
      refusal(post({ "content-type": "application/x-www-form-urlencoded" }), bound)?.status,
    ).toBe(415);
    expect(
      refusal(post({ "content-type": "application/json; charset=utf-8" }), bound),
    ).toBeUndefined();
  });

  test("answers each path only its own method", () => {
    expect(refusal(request({ method: "POST", path: "/events" }), bound)?.status).toBe(405);
    expect(refusal(request({ method: "GET", path: "/rpc" }), bound)?.status).toBe(405);
    expect(refusal(request({ method: "DELETE", path: "/rpc" }), bound)?.status).toBe(405);
  });
});
