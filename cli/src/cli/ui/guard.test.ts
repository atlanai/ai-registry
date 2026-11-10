import { describe, expect, test } from "vitest";
import { type Incoming, refusal } from "./guard.ts";

const bound = { port: 4000, token: "a".repeat(43) };
const auth = `Bearer ${bound.token}`;

function request(over: Partial<Incoming> & { headers?: Incoming["headers"] }): Incoming {
  return {
    method: "GET",
    path: "/api/state",
    ...over,
    headers: { host: "127.0.0.1:4000", authorization: auth, ...over.headers },
  };
}

const post = (headers: Incoming["headers"]) =>
  request({
    method: "POST",
    path: "/api/actions",
    headers: { origin: "http://127.0.0.1:4000", "content-type": "application/json", ...headers },
  });

describe("a request to aireg ui", () => {
  test("passes with its own host, the token, and for a write its own origin and JSON", () => {
    expect(refusal(request({}), bound)).toBeUndefined();
    expect(refusal(post({}), bound)).toBeUndefined();
    expect(
      refusal(post({ host: "localhost:4000", origin: "http://localhost:4000" }), bound),
    ).toBeUndefined();
  });

  test("is refused under any other host name, as a rebound one would send", () => {
    expect(refusal(request({ headers: { host: "evil.example:4000" } }), bound)?.status).toBe(421);
    expect(refusal(request({ headers: { host: "127.0.0.1:4001" } }), bound)?.status).toBe(421);
    expect(refusal(request({ path: "/", headers: { host: undefined } }), bound)?.status).toBe(421);
  });

  test("reads nothing from the API without the token", () => {
    expect(refusal(request({ headers: { authorization: undefined } }), bound)?.status).toBe(401);
    expect(refusal(request({ headers: { authorization: "Bearer wrong" } }), bound)?.status).toBe(
      401,
    );
    expect(
      refusal(request({ headers: { authorization: `Bearer ${bound.token}x` } }), bound)?.status,
    ).toBe(401);
  });

  test("serves the page itself to anyone at its address, and only to read", () => {
    expect(
      refusal(request({ path: "/", headers: { authorization: undefined } }), bound),
    ).toBeUndefined();
    expect(refusal(request({ method: "POST", path: "/" }), bound)?.status).toBe(405);
  });

  test("refuses a write from another origin, even one holding the token", () => {
    expect(refusal(post({ origin: "https://evil.example" }), bound)?.status).toBe(403);
    expect(refusal(post({ origin: undefined }), bound)?.status).toBe(403);
    expect(refusal(post({ "sec-fetch-site": "cross-site" }), bound)?.status).toBe(403);
  });

  test("takes a write only as JSON, which a form on another site cannot send", () => {
    expect(refusal(post({ "content-type": "text/plain" }), bound)?.status).toBe(415);
    expect(
      refusal(post({ "content-type": "application/x-www-form-urlencoded" }), bound)?.status,
    ).toBe(415);
    expect(
      refusal(post({ "content-type": "application/json; charset=utf-8" }), bound),
    ).toBeUndefined();
  });

  test("answers only GET and POST", () => {
    expect(refusal(request({ method: "DELETE" }), bound)?.status).toBe(405);
  });
});
