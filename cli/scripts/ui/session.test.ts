import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";

const source = readFileSync(new URL("../../ui/public/js/session.js", import.meta.url), "utf8");

function browser(hash = "", saved = "") {
  const messages: object[] = [];
  const gate = { hidden: true };
  const surface = {
    inert: false,
    setAttribute() {
      this.inert = true;
    },
  };
  const storage = new Map([["aireg-web-token", saved]]);
  const location = {
    hash,
    pathname: "/",
    reloads: 0,
    reload() {
      this.reloads += 1;
    },
  };
  let hashchange: (() => void) | undefined;
  let receiver: ((event: { data: object }) => void) | undefined;
  const api = runInNewContext(
    `${source.replace(/^export /gm, "")}\n({ sessionToken, sessionResult });`,
    {
      location,
      addEventListener: (_event: string, listener: () => void) => {
        hashchange = listener;
      },
      history: {
        replaceState() {
          location.hash = "";
        },
      },
      sessionStorage: {
        getItem: (key: string) => storage.get(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      document: { getElementById: (id: string) => (id === "sessionGate" ? gate : surface) },
      BroadcastChannel: class {
        set onmessage(handler: typeof receiver) {
          receiver = handler;
        }
        postMessage(value: object) {
          messages.push(value);
        }
      },
    },
  ) as { sessionToken(): Promise<string>; sessionResult(status: number): void };
  return {
    api,
    messages,
    gate,
    surface,
    storage,
    location,
    hashchange: () => hashchange?.(),
    receive: (data: object) => receiver?.({ data }),
  };
}

describe("browser sessions", () => {
  test("consumes a launch address without retaining the credential in the URL", async () => {
    const token = "s".repeat(32);
    const b = browser(`#token=${token}`);
    expect(await b.api.sessionToken()).toBe(token);
    expect(b.location.hash).toBe("");
    expect(b.storage.get("aireg-web-token")).toBe(token);
  });

  test("shares only a session the API has accepted, then stops sharing after rejection", async () => {
    const b = browser("", "s".repeat(32));
    await b.api.sessionToken();
    b.receive({ type: "request" });
    expect(b.messages).toEqual([]);
    b.api.sessionResult(200);
    b.receive({ type: "request" });
    expect(b.messages).toContainEqual({ type: "session", token: "s".repeat(32) });
    b.api.sessionResult(401);
    const before = b.messages.length;
    b.receive({ type: "request" });
    expect(b.messages.length).toBe(before);
    expect(b.gate.hidden).toBe(false);
    expect(b.surface.inert).toBe(true);
  });

  test("a plain tab asks an authenticated tab to connect it and rejects malformed replies", async () => {
    const b = browser();
    expect(await b.api.sessionToken()).toBe("");
    expect(b.messages).toEqual([{ type: "request" }]);
    b.receive({ type: "session", token: "invalid" });
    expect(b.location.reloads).toBe(0);
    b.receive({ type: "session", token: "s".repeat(32) });
    expect(b.location.reloads).toBe(1);
    expect(b.storage.get("aireg-web-token")).toBe("s".repeat(32));
  });
});

test("a fresh launch address in an existing tab reloads to consume its session", async () => {
  const b = browser("", "s".repeat(32));
  await b.api.sessionToken();
  b.location.hash = "#other";
  b.hashchange();
  expect(b.location.reloads).toBe(0);
  b.location.hash = `#token=${"t".repeat(32)}`;
  b.hashchange();
  expect(b.location.reloads).toBe(1);
});
