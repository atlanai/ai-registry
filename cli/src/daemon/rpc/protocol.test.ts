import { describe, expect, test } from "vitest";
import { encodeMessage, ProtocolError, parseMessage } from "./protocol.ts";

describe("JSON-RPC codec", () => {
  test("round trips requests and rejects mixed envelopes", () => {
    const request = { jsonrpc: "2.0" as const, id: "request_1", method: "run.list", params: {} };
    expect(parseMessage(encodeMessage(request))).toEqual(request);
    expect(() => parseMessage('{"jsonrpc":"2.0","id":1,"method":"run.list","result":{}}')).toThrow(
      ProtocolError,
    );
  });
});
