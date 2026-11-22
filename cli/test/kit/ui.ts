import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createInterface } from "node:readline";
import type { UiEvent, UiMethod, UiMethods } from "#cli/ui/protocol.ts";
import type { Home } from "./home.ts";
import { BIN } from "./run.ts";

export interface Served {
  /** What `aireg ui --json` printed first. */
  printed: { ok: boolean; data: { url: string; port: number } };
  port: number;
  origin: string;
  token: string;
  /** Sends SIGINT and resolves with the exit code. */
  stop(): Promise<number | null>;
  /** Resolves with the exit code; a launch that reopened a server exits on its own. */
  exited: Promise<number | null>;
}

/** `aireg ui` serves until stopped, so it is spawned and read line by line, not run to its end. */
export async function serveUi(home: Home, cwd: string): Promise<Served> {
  const child = spawn(process.execPath, [BIN, "ui", "--no-open", "--json"], {
    cwd,
    env: { ...process.env, ...home.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  const line = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("aireg ui printed no address.")), 20_000);
    createInterface({ input: child.stdout }).once("line", (first) => {
      clearTimeout(timer);
      resolve(first);
    });
    child.once("exit", (code) => reject(new Error(`aireg ui exited with ${code} before serving.`)));
  });
  const printed = JSON.parse(line) as Served["printed"];
  const url = new URL(printed.data.url);
  return {
    printed,
    port: printed.data.port,
    origin: url.origin,
    token: url.hash.replace(/^#token=/, ""),
    stop: () => {
      child.kill("SIGINT");
      return exited;
    },
    exited,
  };
}

export interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Raw HTTP, because `fetch` will not send a Host or an Origin of the caller's choosing. */
export function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { host: `127.0.0.1:${port}`, ...options.headers },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}

/** What the page sends with every call: its own origin and JSON. */
export function pageHeaders(ui: Served, session: Record<string, string>): Record<string, string> {
  return { ...session, "content-type": "application/json", origin: ui.origin };
}

/** Trades the launch token for the page's cookie, as the page does once. */
export async function session(ui: Served): Promise<Record<string, string>> {
  const answer = await send(ui.port, "/session", {
    method: "POST",
    headers: pageHeaders(ui, {}),
    body: JSON.stringify({ token: ui.token }),
  });
  const cookie = [answer.headers["set-cookie"] ?? []].flat()[0] ?? "";
  return { cookie: cookie.split(";")[0] ?? "" };
}

export type Reply<M extends UiMethod> =
  | { result: UiMethods[M]["result"]; error?: undefined }
  | { result?: undefined; error: { code: number; message: string; data?: { hint?: string } } };

export async function rpc<M extends UiMethod>(
  ui: Served,
  auth: Record<string, string>,
  method: M,
  params: UiMethods[M]["params"] | Record<string, unknown> = {},
): Promise<Reply<M>> {
  const answer = await send(ui.port, "/rpc", {
    method: "POST",
    headers: pageHeaders(ui, auth),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (answer.status !== 200) throw new Error(`/rpc answered ${answer.status}: ${answer.body}`);
  return JSON.parse(answer.body) as Reply<M>;
}

export interface Listening {
  events: UiEvent[];
  /** Resolves with the first event, seen or still to come, that matches. */
  next(match: (event: UiEvent) => boolean, timeoutMs?: number): Promise<UiEvent>;
  close(): void;
}

/** Opens `GET /events` and keeps every event it pushes. */
export function listen(ui: Served, auth: Record<string, string>): Promise<Listening> {
  return new Promise((resolve, reject) => {
    const events: UiEvent[] = [];
    const waiting = new Set<() => void>();
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: ui.port,
        path: "/events",
        headers: { host: `127.0.0.1:${ui.port}`, ...auth },
      },
      (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`/events answered ${response.statusCode}`));
          return;
        }
        let buffer = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          let at = buffer.indexOf("\n\n");
          while (at >= 0) {
            const data = buffer
              .slice(0, at)
              .split("\n")
              .find((field) => field.startsWith("data: "));
            if (data !== undefined) events.push(JSON.parse(data.slice(6)) as UiEvent);
            buffer = buffer.slice(at + 2);
            at = buffer.indexOf("\n\n");
          }
          for (const wake of waiting) wake();
        });
        resolve({
          events,
          next: (match, timeoutMs = 60_000) =>
            new Promise((found, failed) => {
              const check = () => {
                const event = events.find(match);
                if (event === undefined) return;
                waiting.delete(check);
                clearTimeout(timer);
                found(event);
              };
              const timer = setTimeout(() => {
                waiting.delete(check);
                failed(new Error("No such event arrived."));
              }, timeoutMs);
              waiting.add(check);
              check();
            }),
          close: () => outgoing.destroy(),
        });
      },
    );
    outgoing.on("error", () => {});
    outgoing.end();
  });
}
