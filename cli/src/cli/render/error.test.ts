import { describe, expect, test } from "vitest";
import { AdapterError } from "#adapter/index.ts";
import { AiregError, ErrorCode, ExitCode } from "#core/errors.ts";
import { LeaseError } from "#core/lease/errors.ts";
import { Printer } from "#core/term/printer.ts";
import { RpcClientError } from "#daemon/rpc/client.ts";
import { reportError } from "./error.ts";

function capture(format: "text" | "json") {
  const out: string[] = [];
  const err: string[] = [];
  const printer = new Printer({
    format,
    out: { write: (chunk: string) => out.push(chunk), isTTY: false },
    err: { write: (chunk: string) => err.push(chunk), isTTY: false },
  });
  return { printer, out, err };
}

describe("reportError", () => {
  test("keeps the code and hint of a failure the daemon classified", () => {
    const { printer, out } = capture("json");
    const refused = new RpcClientError(-32602, "acme is elsewhere.", {
      code: "usage",
      hint: "Declare it under another name.",
    });
    expect(reportError(printer, refused)).toBe(ExitCode.Usage);
    expect(JSON.parse(out.join("")).error).toEqual({
      code: "usage",
      message: "acme is elsewhere.",
      hint: "Declare it under another name.",
    });
  });

  test("keeps the AiregError hint on --json", () => {
    const { printer, out } = capture("json");
    const code = reportError(
      printer,
      new AiregError("Unknown command `why`.", { hint: "Run `aireg --help` for the list." }),
    );
    expect(code).toBe(ExitCode.Error);
    expect(JSON.parse(out.join(""))).toEqual({
      ok: false,
      error: {
        code: "error",
        message: "Unknown command `why`.",
        hint: "Run `aireg --help` for the list.",
      },
    });
  });

  test("tells a writer that lost its write lock to run again", () => {
    const { printer, err } = capture("text");
    const lost = new LeaseError("Another aireg process took over this project.", {
      reason: "lease_lost",
      hint: "Run the command again.",
    });
    expect(reportError(printer, lost)).toBe(ExitCode.Error);
    expect(err.join("")).toContain("code: busy");
    expect(err.join("")).toContain("hint: Run the command again.");
  });

  test("prints no code line for a plain error", () => {
    const { printer, err } = capture("text");
    reportError(printer, new AiregError("Nothing to add."));
    expect(err.join("")).toBe("error: Nothing to add.\n");
  });

  test("prints the code, hint and trace of a registry's failure", () => {
    const { printer, err } = capture("text");
    const error = new AdapterError("acme", "unauthorized", "Token expired: sign in again", {
      problem: {
        code: "token_expired",
        title: "Token expired",
        detail: "sign in again",
        status: 401,
        trace_id: "trc_1",
      },
      hint: "Run `aireg auth login catalog`.",
    });
    expect(reportError(printer, error)).toBe(ExitCode.AuthRequired);
    expect(err.join("")).toContain("error: Token expired: sign in again");
    expect(err.join("")).toContain("code: unauthorized");
    expect(err.join("")).toContain("hint: Run `aireg auth login catalog`.");
    expect(err.join("")).toContain("trace: trc_1");
  });

  test("keeps the code and hint of an AdapterError carried as a AiregError cause", () => {
    const { printer, out } = capture("json");
    const cause = new AdapterError("git", "not_found", "repository not found", {
      hint: "Check the address.",
    });
    reportError(printer, new AiregError(cause.message, { cause }));
    expect(JSON.parse(out.join(""))).toEqual({
      ok: false,
      error: {
        code: "not_found",
        message: "repository not found",
        hint: "Check the address.",
        adapter: "git",
      },
    });
  });

  test("reports a usage AiregError with the usage code", () => {
    const { printer, out } = capture("json");
    expect(reportError(printer, new AiregError("Nothing to add.", { code: ErrorCode.Usage }))).toBe(
      ExitCode.Usage,
    );
    expect(JSON.parse(out.join(""))).toEqual({
      ok: false,
      error: { code: "usage", message: "Nothing to add." },
    });
  });
});
