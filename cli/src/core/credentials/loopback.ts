import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { finished } from "node:stream/promises";
import { AiregError, ErrorCode } from "#core/errors.ts";

const CALLBACK_PATH = "/callback";
const DONE_PATH = "/done";
/** A tab closed before the outcome page loads must not hold the port open. */
const ARRIVAL_MS = 2_000;
/** An OAuth error code; anything else is the server's free text and may say anything. */
export const ERROR_CODE = /^[a-z_]{1,64}$/;

/** The pages load nothing, so nothing they load can see the code in an address. */
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  connection: "close",
};

export function signInFailed(message: string, cause?: unknown): AiregError {
  return new AiregError(message, { code: ErrorCode.Unauthorized, cause });
}

/**
 * The loopback redirect of RFC 8252: one answer for this `state`, then the tab moves to a
 * page without the code in its address, held until `close` says how the sign-in ended.
 */
export async function listenForCode(
  expected: Expected,
  ports: readonly number[],
): Promise<Callback> {
  let settle: { accept(code: string): void; reject(error: Error): void } | undefined;
  const code = new Promise<string>((accept, reject) => {
    settle = { accept, reject };
  });
  // Awaited in a race it may lose; a late refusal must not surface as an unhandled one.
  code.catch(() => undefined);
  let arrived: () => void = () => {};
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const waiting = new Set<ServerResponse>();
  let outcome: boolean | undefined;
  let redeemed = false;
  let answered = false;
  let host = "";

  const http = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // A page elsewhere that rebinds its own name to 127.0.0.1 sends its own Host.
    if (request.headers.host !== host) return answer(response, 421, "Wrong address.");
    if (request.method !== "GET") return answer(response, 405, "Not allowed.");
    if (url.pathname === DONE_PATH && redeemed) {
      arrived();
      if (outcome !== undefined) return tell(response, outcome);
      waiting.add(response);
      response.once("close", () => waiting.delete(response));
      return;
    }
    if (url.pathname !== CALLBACK_PATH) return answer(response, 404, "Not found.");
    // Anything else on this port is another page's request, not this sign-in's answer.
    if (url.searchParams.get("state") !== expected.state) {
      return answer(response, 400, "This sign-in expired.");
    }
    if (answered) return answer(response, 409, "This sign-in already finished.");
    answered = true;
    const iss = url.searchParams.get("iss");
    if (iss === null ? expected.namesIssuer : iss !== expected.issuer) {
      answer(response, 400, "This sign-in came back from another server.");
      return settle?.reject(
        signInFailed("The sign-in came back from a server other than the one it went to."),
      );
    }
    const value = url.searchParams.get("code");
    if (value === null || value === "") {
      answer(response, 400, "The sign-in did not finish. You can close this tab.");
      return settle?.reject(refusal(url.searchParams.get("error")));
    }
    redeemed = true;
    // See other, so the address the code came in on is not the one the tab keeps.
    response.writeHead(303, { ...PAGE_HEADERS, location: DONE_PATH }).end();
    settle?.accept(value);
  });
  await bind(http, ports.length === 0 ? [0] : ports);
  const { port } = http.address() as AddressInfo;
  host = `127.0.0.1:${port}`;

  return {
    redirectUri: `http://${host}${CALLBACK_PATH}`,
    port,
    code,
    close: async (signedIn) => {
      outcome = signedIn;
      // A tab closed meanwhile never arrives or takes its page, so the wait is bounded.
      const limit = delay(ARRIVAL_MS);
      if (redeemed) await Promise.race([arrival, limit.done]);
      const told = [...waiting].map((response) => {
        tell(response, signedIn);
        // A tab closed before its page arrived does not undo the sign-in.
        return finished(response).catch(() => undefined);
      });
      await Promise.race([Promise.all(told), limit.done]);
      limit.clear();
      http.close();
      http.closeAllConnections();
    },
  };
}

function answer(response: ServerResponse, status: number, message: string): void {
  response
    .writeHead(status, PAGE_HEADERS)
    .end(`<!doctype html><meta charset="utf-8"><title>aireg</title><p>${message}</p>`);
}

function tell(response: ServerResponse, signedIn: boolean): void {
  signedIn
    ? answer(response, 200, "Signed in. You can close this tab and go back to the terminal.")
    : answer(response, 500, "The sign-in did not finish. The terminal says why.");
}

function refusal(error: string | null): AiregError {
  if (error === "access_denied") return signInFailed("The sign-in was declined in the browser.");
  const reason = ERROR_CODE.test(error ?? "") ? ` (${error})` : "";
  return signInFailed(`The sign-in was not completed${reason}.`);
}

export interface Expected {
  state: string;
  issuer: string;
  namesIssuer: boolean;
}

export interface Callback {
  redirectUri: string;
  port: number;
  code: Promise<string>;
  close(signedIn: boolean): Promise<void>;
}

async function bind(http: Server, ports: readonly number[]): Promise<void> {
  let failure: NodeJS.ErrnoException | undefined;
  for (const port of ports) {
    const bound = await new Promise<boolean>((resolve) => {
      const refused = (error: NodeJS.ErrnoException) => {
        failure = error;
        resolve(false);
      };
      http.once("error", refused);
      http.listen(port, "127.0.0.1", () => {
        http.off("error", refused);
        resolve(true);
      });
    });
    if (bound) return;
  }
  if (failure?.code !== "EADDRINUSE" || ports.includes(0)) {
    throw signInFailed("Cannot listen on 127.0.0.1 for the sign-in to come back.", failure);
  }
  throw signInFailed(
    `Ports ${ports.join(", ")} are all in use, and the sign-in can only come back to one of them.`,
  );
}

function delay(ms: number): { done: Promise<void>; clear(): void } {
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { done, clear: () => clearTimeout(timer) };
}
