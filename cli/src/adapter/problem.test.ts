import { describe, expect, test } from "vitest";
import { failureFromStatus, readProblem, retryAfterMs } from "./problem.ts";

describe("readProblem", () => {
  test("keeps a server's snake_case code and trace_id", () => {
    expect(
      readProblem(401, {
        code: "token_expired",
        title: "Token expired",
        detail: "sign in again",
        status: 401,
        trace_id: "abc",
      }),
    ).toEqual({
      code: "token_expired",
      title: "Token expired",
      detail: "sign in again",
      status: 401,
      trace_id: "abc",
    });
  });

  test("mints a code when the server sent only a status", () => {
    expect(readProblem(404, { detail: "nothing here" })).toMatchObject({
      code: "NOT_FOUND",
      title: "HTTP 404",
      detail: "nothing here",
      status: 404,
    });
  });

  test("reads a nested SDK body so classify does not have to", () => {
    expect(
      readProblem(409, { body: { code: "already_exists", title: "taken", status: 409 } }),
    ).toMatchObject({ code: "already_exists", title: "taken", status: 409 });
  });
});

describe("failureFromStatus", () => {
  test("maps 409 to conflict and 429 to unavailable", () => {
    expect(failureFromStatus(409)).toBe("conflict");
    expect(failureFromStatus(429)).toBe("unavailable");
    expect(failureFromStatus(403)).toBe("forbidden");
  });
});

describe("retryAfterMs", () => {
  test("reads a delta Retry-After header", () => {
    const headers = new Headers({ "retry-after": "2" });
    expect(retryAfterMs(headers)).toBe(2000);
  });
});
