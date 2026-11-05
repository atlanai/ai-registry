/** `Server` is a classified failure; `StaleRevision` carries the `data.revision` to resync from. */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  Server: -32000,
  UnsupportedVersion: -32001,
  NotInitialized: -32002,
  StaleRevision: -32003,
  NotFound: -32004,
  // The job already has a run going.
  Busy: -32005,
} as const;

export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];
