import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createInterface } from "node:readline";
import type { Home } from "./home.ts";
import { BIN } from "./run.ts";

export interface Served {
  /** What `aireg ui --json` printed first. */
  printed: { ok: boolean; data: { url: string; port: number } };
  origin: string;
  token: string;
  /** Sends SIGINT and resolves with the exit code. */
  stop(): Promise<number | null>;
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
    origin: url.origin,
    token: url.hash.replace(/^#token=/, ""),
    stop: () => {
      child.kill("SIGINT");
      return exited;
    },
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
