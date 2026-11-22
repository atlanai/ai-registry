import type { UiMethod, UiMethods, UiRpcResponse } from "../../../src/cli/ui/protocol.ts";

/** The server no longer knows this tab: it stopped, or another launch replaced it. */
export class SessionEnded extends Error {}

/** A refusal the server explains; `hint` says what to do next. */
class RpcError extends Error {
  readonly code: number;
  readonly hint: string | undefined;
  constructor(code: number, message: string, hint: string | undefined) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

const TOKEN = /^#(?:token=)?([A-Za-z0-9_-]{16,128})$/;
let ended = false;
const endedListeners = new Set<() => void>();

export function onSessionEnded(listener: () => void): () => void {
  endedListeners.add(listener);
  return () => endedListeners.delete(listener);
}

export function sessionEnded(): boolean {
  return ended;
}

function endSession(): never {
  if (!ended) {
    ended = true;
    for (const listener of endedListeners) listener();
  }
  throw new SessionEnded("Session ended");
}

/** Trades the launch token in the address for an HttpOnly cookie, then drops it from history. */
export async function startSession(): Promise<void> {
  const match = TOKEN.exec(location.hash);
  if (match === null) return;
  history.replaceState(null, "", location.pathname + location.search);
  const response = await fetch("/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: match[1] }),
  });
  if (response.status === 401) endSession();
}

let nextId = 1;

export async function rpc<M extends UiMethod>(
  method: M,
  params: UiMethods[M]["params"],
): Promise<UiMethods[M]["result"]> {
  if (ended) endSession();
  const id = nextId++;
  const response = await fetch("/rpc", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (response.status === 401) endSession();
  if (!response.ok)
    throw new RpcError(response.status, `The server answered ${response.status}.`, undefined);
  const body = (await response.json()) as UiRpcResponse<M>;
  if ("error" in body) {
    const data = body.error.data as { hint?: unknown } | undefined;
    const hint = typeof data?.hint === "string" ? data.hint : undefined;
    throw new RpcError(body.error.code, body.error.message, hint);
  }
  return body.result;
}

export function describeError(error: unknown): { title: string; hint: string | undefined } {
  if (error instanceof RpcError) return { title: error.message, hint: error.hint };
  if (error instanceof Error) return { title: error.message, hint: undefined };
  return { title: "Something went wrong.", hint: undefined };
}
