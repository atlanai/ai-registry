import { type Operations, UiError } from "./operations.ts";
import type { PageReader } from "./page-state.ts";
import type { UiMethod, UiMethods, UiRpcResponse } from "./protocol.ts";
import { viewOf } from "./view.ts";

/** JSON-RPC 2.0's own codes, and one for a refusal the page shows. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
export const REFUSED = -32000;

/** A name the page sends: one path segment, so `..` or `/` never reaches the disk. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class InvalidParams extends Error {}

type Params = Record<string, unknown>;
type Handler<M extends UiMethod> = (
  params: Params,
  served: Served,
) => Promise<UiMethods[M]["result"]> | UiMethods[M]["result"];

export interface Served {
  reader: PageReader;
  operations: Operations;
}

const HANDLERS: { [M in UiMethod]: Handler<M> } = {
  "state.snapshot": async (params, { reader }) => {
    only(params, []);
    return viewOf(await reader.read());
  },
  "artifact.file": (params, { operations }) => {
    only(params, ["key"]);
    return operations.file(text(params.key, 512));
  },
  "install.plan": (params, { operations }) => {
    only(params, ["source", "select"]);
    return operations.plan(source(params.source), names(params.select ?? []));
  },
  "install.apply": (params, { operations }) => {
    only(params, ["planId", "trust"]);
    return operations.apply(text(params.planId, 64), names(params.trust));
  },
  "remove.start": (params, { operations }) => {
    only(params, ["key"]);
    return operations.remove(text(params.key, 512));
  },
  "sync.start": (params, { operations }) => {
    only(params, []);
    return operations.sync();
  },
  "doctor.run": (params, { operations }) => {
    only(params, []);
    return operations.doctor();
  },
  "run.cancel": (params, { operations }) => {
    only(params, ["runId"]);
    return operations.cancel(text(params.runId, 64));
  },
};

/** One request in, one response out; never throws. */
export async function dispatch(body: string, served: Served): Promise<UiRpcResponse> {
  let request: unknown;
  try {
    request = JSON.parse(body);
  } catch {
    return failure(0, PARSE_ERROR, "The request is not JSON.");
  }
  if (!isRecord(request)) return failure(0, INVALID_REQUEST, "Send one JSON-RPC request.");
  const id = Number.isSafeInteger(request.id) ? (request.id as number) : undefined;
  if (request.jsonrpc !== "2.0" || id === undefined || typeof request.method !== "string") {
    return failure(id ?? 0, INVALID_REQUEST, "Send one JSON-RPC 2.0 request with a numeric id.");
  }
  if (!Object.hasOwn(HANDLERS, request.method)) {
    return failure(id, METHOD_NOT_FOUND, "There is no such method.");
  }
  const params = request.params ?? {};
  if (!isRecord(params)) return failure(id, INVALID_PARAMS, "Params are an object.");
  const handler = HANDLERS[request.method as UiMethod] as Handler<UiMethod>;
  try {
    return { jsonrpc: "2.0", id, result: await handler(params, served) };
  } catch (error) {
    if (error instanceof InvalidParams) return failure(id, INVALID_PARAMS, error.message);
    if (error instanceof UiError) {
      return failure(
        id,
        REFUSED,
        error.message,
        error.hint === undefined ? undefined : { hint: error.hint },
      );
    }
    throw error;
  }
}

function failure(id: number, code: number, message: string, data?: unknown): UiRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function only(params: Params, allowed: readonly string[]): void {
  const stray = Object.keys(params).find((key) => !allowed.includes(key));
  if (stray !== undefined) throw new InvalidParams(`Unknown parameter ${JSON.stringify(stray)}.`);
}

/** One printable line, bounded. */
function text(value: unknown, longest: number): string {
  if (typeof value !== "string") throw new InvalidParams("Expected a string.");
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at);
    if (code < 0x20 || code === 0x7f) throw new InvalidParams("Expected printable text.");
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > longest) {
    throw new InvalidParams("Expected one short line.");
  }
  return trimmed;
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) throw new InvalidParams("Expected a list of names.");
  if (value.length > 100) throw new InvalidParams("Name at most 100 at a time.");
  if (value.some((item) => typeof item !== "string" || !SAFE_NAME.test(item))) {
    throw new InvalidParams("Each name is letters, digits, dots, dashes or underscores.");
  }
  return [...new Set(value as string[])];
}

/** Rides after `--`; credentials would sit in the process list and in this page. */
function source(value: unknown): string {
  const given = text(value, 2048);
  if (given.startsWith("-")) throw new InvalidParams("Give a source address or repository.");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(given)) {
    let url: URL;
    try {
      url = new URL(given);
    } catch {
      throw new InvalidParams("Give a source address or repository.");
    }
    if (url.username !== "" || url.password !== "" || url.search !== "") {
      throw new UiError(
        "Give the address without a user name, token or query.",
        "Sign in with `aireg auth login` instead.",
      );
    }
  } else if (/^[^/@\s]*:[^/@\s]*@/.test(given)) {
    // `user:token@host:path`, the scp form with a password.
    throw new UiError(
      "Give the address without a token.",
      "Sign in with `aireg auth login` instead.",
    );
  }
  return given;
}
