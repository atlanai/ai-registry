import { createHash } from "node:crypto";
import { createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import type { Credential } from "#adapter/index.ts";
import { type SignInPrompt, signInWithOAuth } from "./oauth.ts";

interface Stub {
  issuer: string;
  exchanged: URLSearchParams[];
  close(): Promise<void>;
}

interface StubOptions {
  refuse?: string;
  tokenOrigin?: string;
  metadataIssuer?: string;
  /** Its own issuer by default, null for none. */
  iss?: string | null;
}

/** An authorization server that signs anyone in, or refuses with `refuse`. */
async function stub(options: StubOptions = {}): Promise<Stub> {
  const challenges = new Map<string, string>();
  const exchanged: URLSearchParams[] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          issuer: options.metadataIssuer ?? issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${options.tokenOrigin ?? issuer}/oauth/token`,
          authorization_response_iss_parameter_supported: true,
        }),
      );
      return;
    }
    if (url.pathname === "/oauth/authorize") {
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      const iss = options.iss === undefined ? issuer : options.iss;
      if (iss !== null) back.searchParams.set("iss", iss);
      if (options.refuse === undefined) {
        challenges.set("code-1", url.searchParams.get("code_challenge") ?? "");
        back.searchParams.set("code", "code-1");
      } else {
        back.searchParams.set("error", options.refuse);
        back.searchParams.set("error_description", "\u001B]8;;evil\u0007click");
      }
      response.writeHead(302, { location: back.href }).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const form = new URLSearchParams(body);
      exchanged.push(form);
      const proven =
        createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url") === challenges.get(form.get("code") ?? "");
      response
        .writeHead(proven ? 200 : 400, { "content-type": "application/json" })
        .end(
          JSON.stringify(
            proven
              ? { access_token: "access-1", refresh_token: "refresh-1", expires_in: 900 }
              : { error: "invalid_grant" },
          ),
        );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    exchanged,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface Page {
  url: string;
  status: number;
  headers: Headers;
  text: string;
}

/** Follows the redirects back to aireg, as the person's browser would. */
function browser(): SignInPrompt & { shown: string[]; page: Promise<Page> } {
  const shown: string[] = [];
  let show: (page: Page) => void = () => {};
  const page = new Promise<Page>((resolve) => {
    show = resolve;
  });
  return {
    shown,
    page,
    waiting: (url) => shown.push(url),
    open: (url) => {
      void fetch(url)
        .then(async (answer) =>
          show({
            url: answer.url,
            status: answer.status,
            headers: answer.headers,
            text: await answer.text(),
          }),
        )
        .catch(() => {});
    },
  };
}

/** A page on a name rebound to 127.0.0.1 reaches the port, but sends that name as Host. */
function rebound(url: URL): Promise<number> {
  return new Promise((resolve, reject) => {
    get(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: { host: `attacker.example:${url.port}` },
      },
      (answer) => {
        answer.resume();
        resolve(answer.statusCode ?? 0);
      },
    ).on("error", reject);
  });
}

const keep = async (credential: Credential) => credential;
const never = new AbortController().signal;

let server: Stub | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("signInWithOAuth", () => {
  test("signs in with PKCE, and tells the tab only once the sign-in is stored", async () => {
    server = await stub();
    const prompt = browser();
    let stored = false;
    const credential = await signInWithOAuth(
      { issuer: server.issuer, clientId: "client-1", scopes: ["openid"] },
      prompt,
      never,
      async (signedIn) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        stored = true;
        return signedIn;
      },
    );
    expect(credential).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" });
    expect(Object.fromEntries(new URL(prompt.shown[0] ?? "").searchParams)).toMatchObject({
      client_id: "client-1",
      code_challenge_method: "S256",
      scope: "openid",
    });
    const page = await prompt.page;
    expect(stored).toBe(true);
    expect(page.status).toBe(200);
    expect(new URL(page.url).pathname).toBe("/done");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("says the person declined, and never the server's own words", async () => {
    server = await stub({ refuse: "access_denied" });
    await expect(
      signInWithOAuth({ issuer: server.issuer, clientId: "client-1" }, browser(), never, keep),
    ).rejects.toThrow(/^The sign-in was declined in the browser\.$/);
  });

  test.each([
    [{ metadataIssuer: "https://elsewhere.example" }, "metadata is for another server"],
    [{ tokenOrigin: "https://elsewhere.example" }, "token endpoint is not on"],
    [{ iss: "https://elsewhere.example" }, "came back from a server other than"],
    [{ iss: null }, "came back from a server other than"],
  ])(
    "refuses a server that is not the one asked for (%o), redeeming nothing",
    async (options, message) => {
      server = await stub(options);
      await expect(
        signInWithOAuth({ issuer: server.issuer, clientId: "client-1" }, browser(), never, keep),
      ).rejects.toThrow(message);
      expect(server.exchanged).toEqual([]);
    },
  );

  test("ignores an answer for another sign-in, or sent to another host name", async () => {
    server = await stub();
    const prompt = browser();
    const statuses: number[] = [];
    const pending = signInWithOAuth(
      { issuer: server.issuer, clientId: "client-1" },
      {
        waiting: prompt.waiting,
        open: (url) => {
          const redirect = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
          redirect.searchParams.set("state", "someone-else");
          redirect.searchParams.set("code", "stolen");
          void fetch(redirect)
            .then((answer) => statuses.push(answer.status))
            .then(() => rebound(new URL(redirect)))
            .then((status) => statuses.push(status))
            .then(() => fetch(url));
        },
      },
      never,
      keep,
    );
    await expect(pending).resolves.toMatchObject({ accessToken: "access-1" });
    expect(statuses).toEqual([400, 421]);
    expect(server.exchanged.map((form) => form.get("code"))).toEqual(["code-1"]);
  });
});
