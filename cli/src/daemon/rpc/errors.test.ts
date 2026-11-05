import { describe, expect, test } from "vitest";
import { AdapterError } from "#adapter/index.ts";
import { CredentialStoreError } from "#core/credentials/store.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { LeaseError } from "#core/lease/errors.ts";
import { ManifestError } from "#core/manifest/errors.ts";
import { RpcErrorCode } from "./codes.ts";
import { invalidParams, noAccount, noJob, noRun, rpcError, staleSettings } from "./errors.ts";
import { ProtocolError } from "./protocol.ts";

describe("rpcError", () => {
  test("keeps a protocol failure as-is", () => {
    const error = new ProtocolError(RpcErrorCode.NotFound, "account not found");
    expect(rpcError(error)).toBe(error);
  });

  test("sends a handler's refusal as its code, with only the data it gave", () => {
    const missing = rpcError(noJob("job_demo"));
    expect([missing.code, missing.message, missing.data]).toEqual([
      RpcErrorCode.NotFound,
      'No job named "job_demo".',
      undefined,
    ]);
    expect(rpcError(noAccount("acc_demo")).message).toBe('No account named "acc_demo".');
    expect(rpcError(noRun("run_demo"))).toMatchObject({
      code: RpcErrorCode.NotFound,
      message: 'No run named "run_demo".',
    });
    expect(rpcError(invalidParams("Bad.", { hint: "Fix it." }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: "Bad.",
      data: { hint: "Fix it." },
    });
    expect(rpcError(staleSettings(7))).toMatchObject({
      code: RpcErrorCode.StaleRevision,
      data: { revision: 7 },
    });
  });

  test("names an adapter failure instead of swallowing it as internal", () => {
    const mapped = rpcError(new AdapterError("acme", "invalid", "Acme served 50 of 78"));
    expect(mapped).toMatchObject({
      code: RpcErrorCode.Server,
      message: "Acme served 50 of 78",
      data: { code: "INVALID", title: "Acme served 50 of 78" },
    });
  });

  test("puts an adapter's problem on a wrapped AiregError", () => {
    const cause = new AdapterError("acme", "unauthorized", "Token expired", {
      problem: { code: "token_expired", title: "Token expired", status: 401 },
    });
    expect(rpcError(new AiregError(cause.message, { cause }))).toMatchObject({
      code: RpcErrorCode.Server,
      message: "Token expired",
      data: { code: "token_expired", title: "Token expired", status: 401 },
    });
  });

  test("names a packed adapter throw the CLI did not construct", () => {
    const packed = new Error("Acme served 50 of 78");
    packed.name = "AdapterError";
    Object.assign(packed, { adapter: "acme", failure: "invalid" });
    expect(rpcError(packed)).toMatchObject({
      code: RpcErrorCode.Server,
      message: "Acme served 50 of 78",
      data: { code: "INVALID", title: "Acme served 50 of 78" },
    });
  });

  test("maps a usage AiregError to invalid params, keeping its code", () => {
    expect(rpcError(new AiregError("Nothing to add.", { code: ErrorCode.Usage }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: "Nothing to add.",
      data: { code: "usage", title: "Nothing to add." },
    });
  });

  test("names a missing thing as not found, and carries a hint", () => {
    const missing = new AiregError('No account named "acme".', {
      code: ErrorCode.NotFound,
      hint: "Run `aireg auth list` to see the accounts.",
    });
    expect(rpcError(missing)).toMatchObject({
      code: RpcErrorCode.NotFound,
      data: { code: "not_found", hint: "Run `aireg auth list` to see the accounts." },
    });
  });

  test("names an invalid manifest as invalid params, and any other failure as a server error", () => {
    expect(rpcError(new ManifestError("bad yaml")).code).toBe(RpcErrorCode.InvalidParams);
    expect(rpcError(new AiregError("Unknown target: claude.")).code).toBe(RpcErrorCode.Server);
  });

  test("names a credential store failure, with its cause only when it has one", () => {
    const cause = new Error("EACCES: permission denied\nstack");
    expect(rpcError(new CredentialStoreError("Could not read it.", { cause }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: "Could not read it: EACCES: permission denied",
    });
    expect(rpcError(new CredentialStoreError("Not a valid file")).message).toBe("Not a valid file");
  });

  test("names a lease failure instead of calling it internal", () => {
    expect(
      rpcError(new LeaseError("Another process took over", { reason: "lease_lost" })),
    ).toMatchObject({
      code: RpcErrorCode.Server,
      message: "Another process took over",
    });
  });

  test("names a full disk, from the file system or from SQLite", () => {
    const enospc = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    const full = Object.assign(new Error("database or disk is full"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 13,
    });
    for (const error of [enospc, full]) {
      expect(rpcError(error)).toMatchObject({
        code: RpcErrorCode.Server,
        message:
          "No space is left on the disk that holds aireg's state. Free some space, then run the command again.",
      });
    }
  });

  test("does not leak an unclassified throw", () => {
    expect(rpcError(new Error("EACCES /secret"))).toMatchObject({
      code: RpcErrorCode.Internal,
      message: "The aireg daemon hit an unexpected error. Run `aireg logs --daemon` to see it.",
    });
  });
});
