import { isRecord } from "#core/fields.ts";
import { RpcErrorCode } from "./codes.ts";

export type RpcId = string | number;

interface RpcRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: unknown;
}

interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface RpcSuccess {
  jsonrpc: "2.0";
  id: RpcId;
  result: unknown;
}

export interface RpcFailure {
  jsonrpc: "2.0";
  id: RpcId | null;
  error: RpcError;
}

export type RpcIncoming = RpcRequest | RpcNotification;
export type RpcResponse = RpcSuccess | RpcFailure;
export type RpcMessage = RpcIncoming | RpcResponse;

export class ProtocolError extends Error {
  readonly code: RpcErrorCode;
  readonly data: unknown;

  constructor(code: RpcErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.data = data;
  }
}

export function parseMessage(contents: string): RpcMessage {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new ProtocolError(RpcErrorCode.ParseError, "The message is not valid JSON.");
  }
  const message = object(value);
  if (message.jsonrpc !== "2.0")
    throw new ProtocolError(RpcErrorCode.InvalidRequest, "Unsupported JSON-RPC version.");

  if (typeof message.method === "string") {
    if (message.result !== undefined || message.error !== undefined) {
      throw new ProtocolError(RpcErrorCode.InvalidRequest, "A request cannot contain a response.");
    }
    return {
      jsonrpc: "2.0",
      ...(message.id === undefined ? {} : { id: id(message.id) as RpcId }),
      method: message.method,
      ...(message.params === undefined ? {} : { params: message.params }),
    } as RpcIncoming;
  }

  const responseId = id(message.id, true);
  if (message.error !== undefined) {
    if (message.result !== undefined)
      throw new ProtocolError(RpcErrorCode.InvalidRequest, "A response has two outcomes.");
    const error = object(message.error);
    if (typeof error.code !== "number" || typeof error.message !== "string") {
      throw new ProtocolError(RpcErrorCode.InvalidRequest, "JSON-RPC error is invalid.");
    }
    return {
      jsonrpc: "2.0",
      id: responseId,
      error: {
        code: error.code,
        message: error.message,
        ...(error.data === undefined ? {} : { data: error.data }),
      },
    };
  }
  if (message.result === undefined)
    throw new ProtocolError(RpcErrorCode.InvalidRequest, "JSON-RPC response has no outcome.");
  if (responseId === null)
    throw new ProtocolError(
      RpcErrorCode.InvalidRequest,
      "A successful response id cannot be null.",
    );
  return { jsonrpc: "2.0", id: responseId, result: message.result };
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProtocolError(RpcErrorCode.InvalidRequest, "JSON-RPC message must be an object.");
  }
  return value;
}

function id(value: unknown, nullable = false): RpcId | null {
  if (nullable && value === null) return null;
  if (typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))) {
    return value;
  }
  throw new ProtocolError(RpcErrorCode.InvalidRequest, "JSON-RPC id must be a string or integer.");
}

export function encodeMessage(message: RpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}
