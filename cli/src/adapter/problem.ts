import { FAILURE_CODES } from "./codes.ts";
import type { Failure } from "./errors.ts";
import type { Problem } from "./spec/types.ts";

/** How an HTTP status is classified. A server's own `code` is not rewritten here. */
export function failureFromStatus(status: number): Failure {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404 || status === 410) return "not_found";
  if (status === 409) return "conflict";
  if (status === 408 || status === 429 || status >= 500) return "unavailable";
  return "invalid";
}

/** `Retry-After` as milliseconds, delta or HTTP-date. */
export function retryAfterMs(
  headers: { get(name: string): string | null } | undefined,
): number | undefined {
  const header = headers?.get("retry-after");
  if (header === null || header === undefined) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** A problem document for a failure the adapter classified itself, under aireg's code for it. */
export function problemFromFailure(failure: Failure, message: string, status?: number): Problem {
  const problem: Problem = { code: FAILURE_CODES[failure], title: message };
  if (status !== undefined) problem.status = status;
  return problem;
}

/**
 * Parse a problem+json body (or an SDK error that already is one). A server's
 * own `code` is kept; a missing title is minted so the client always has one.
 */
export function readProblem(status: number | undefined, body: unknown): Problem | undefined {
  const record = asRecord(body);
  const nested = asRecord(record?.body) ?? asRecord(record?.data);
  const source =
    nested !== undefined && stringField(nested, "code") !== undefined ? nested : record;
  const resolvedStatus = statusOf(source, status);
  const code = stringField(source, "code");
  const hasProblem =
    code !== undefined ||
    resolvedStatus !== undefined ||
    stringField(source, "title") !== undefined ||
    stringField(source, "detail") !== undefined;
  if (!hasProblem) return undefined;

  const failure = resolvedStatus !== undefined ? failureFromStatus(resolvedStatus) : "invalid";
  const resolvedCode = code ?? FAILURE_CODES[failure];
  const title =
    stringField(source, "title") ??
    (resolvedStatus !== undefined ? `HTTP ${resolvedStatus}` : resolvedCode);
  const problem: Problem = { code: resolvedCode, title };
  const detail = stringField(source, "detail");
  if (detail !== undefined) problem.detail = detail;
  const type = stringField(source, "type");
  if (type !== undefined) problem.type = type;
  const instance = stringField(source, "instance");
  if (instance !== undefined) problem.instance = instance;
  const traceId = stringField(source, "trace_id");
  if (traceId !== undefined) problem.trace_id = traceId;
  if (resolvedStatus !== undefined) problem.status = resolvedStatus;
  const errors = fieldErrors(source?.errors);
  if (errors !== undefined) problem.errors = errors;
  return problem;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function statusOf(
  record: Record<string, unknown> | undefined,
  fallback: number | undefined,
): number | undefined {
  const value = record?.status;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return fallback;
}

function fieldErrors(value: unknown): Problem["errors"] {
  if (!Array.isArray(value)) return undefined;
  const errors: { path?: string; message: string }[] = [];
  for (const item of value) {
    const row = asRecord(item);
    const message = stringField(row, "message");
    if (message === undefined) continue;
    const path = stringField(row, "path");
    errors.push(path === undefined ? { message } : { path, message });
  }
  return errors.length > 0 ? errors : undefined;
}

/** One line for a person: the title, and the detail when it adds something. */
export function describeProblem(problem: Problem): string {
  if (problem.detail !== undefined && problem.detail !== problem.title) {
    return `${problem.title}: ${problem.detail}`;
  }
  return problem.title;
}
