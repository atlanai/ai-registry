import { describe, expect, test } from "vitest";
import {
  isSecretKey,
  KEYED_MARKER,
  KEYED_SUFFIXES,
  maskUserinfo,
  redactKeyedText,
  redactKeyedValue,
  redactText,
} from "./redact.ts";

/** Shaped like a GitHub token, built here so the source holds no token-shaped literal. */
const TOKEN = `ghp_${"0".repeat(36)}`;
/** Synthetic and credential-shaped only in length, so no scanner reads it as a provider's. */
const OPAQUE = `synthetic-credential-${"0".repeat(8)}`;

describe("keyed fields", () => {
  test("matches every suffix in any spelling", () => {
    for (const suffix of KEYED_SUFFIXES) {
      expect(isSecretKey(suffix), suffix).toBe(true);
      expect(isSecretKey(`GITHUB_${suffix.toUpperCase()}`), suffix).toBe(true);
      expect(isSecretKey(`my-${suffix}`), suffix).toBe(true);
    }
    expect(isSecretKey("apiKey")).toBe(true);
    expect(isSecretKey("Authorization")).toBe(true);
    expect(isSecretKey("account_number")).toBe(true);
  });

  test("does not match counts, kinds, or bare key and auth", () => {
    for (const safe of [
      "input_tokens",
      "token_type",
      "tokenizer",
      "max_tokens",
      "key",
      "auth",
      "name",
      "output_tokens",
      "cached_tokens",
    ]) {
      expect(isSecretKey(safe), safe).toBe(false);
    }
  });

  test("masks KEY=value lines and password flags in free text, leaving other pairs alone", () => {
    const text = 'export DB_PASSWORD="hunter22" PORT=5432 token: abcdefgh --password s3cret -p 9';
    const out = redactKeyedText(text);
    expect(out.text).toContain(`DB_PASSWORD="${KEYED_MARKER}"`);
    expect(out.text).toContain("PORT=5432");
    expect(out.text).toContain(`token: ${KEYED_MARKER}`);
    expect(out.text).toContain(`--password ${KEYED_MARKER}`);
    expect(out.text).toContain("-p 9");
    expect(out.count).toBe(3);
  });

  test("leaves short values and non-secret keys", () => {
    expect(redactKeyedText("secret=abc name=alice max_tokens=4096")).toEqual({
      text: "secret=abc name=alice max_tokens=4096",
      count: 0,
    });
  });
});

describe("authorization in free text", () => {
  test("keeps the scheme of an Authorization header and hides the rest of its value", () => {
    for (const scheme of ["Bearer", "Basic", "token", "Digest"]) {
      const out = redactKeyedText(`> Authorization: ${scheme} ${OPAQUE}`);
      expect(out.text, scheme).toBe(`> Authorization: ${scheme} ${KEYED_MARKER}`);
      expect(out.count, scheme).toBe(1);
    }
  });

  test("hides a header value with no scheme, a proxy header, and a quoted header", () => {
    expect(redactKeyedText(`authorization=${OPAQUE}`).text).toBe(`authorization=${KEYED_MARKER}`);
    expect(redactKeyedText(`Proxy-Authorization: Basic ${OPAQUE}`).text).toBe(
      `Proxy-Authorization: Basic ${KEYED_MARKER}`,
    );
    expect(redactKeyedText(`curl -H "Authorization: Bearer ${OPAQUE}" https://x`).text).toBe(
      `curl -H "Authorization: Bearer ${KEYED_MARKER}" https://x`,
    );
    expect(redactKeyedText(`{"Authorization":"token ${OPAQUE}","b":1}`).text).toBe(
      `{"Authorization":"token ${KEYED_MARKER}","b":1}`,
    );
  });

  test("hides a credential after a bare Bearer, Basic or token word", () => {
    expect(redactKeyedText(`sent Bearer ${OPAQUE} to acme`).text).toBe(
      `sent Bearer ${KEYED_MARKER} to acme`,
    );
    expect(redactKeyedText(`retrying with token ${TOKEN}`).text).toBe(
      `retrying with token ${KEYED_MARKER}`,
    );
    expect(redactKeyedText("Basic c3ludGhldGljLWNyZWRlbnRpYWw=").text).toBe(
      `Basic ${KEYED_MARKER}`,
    );
  });

  test("leaves prose that only mentions a scheme word", () => {
    const prose = "Bearer authentication failed; the token expired; basic checks passed";
    expect(redactKeyedText(prose)).toEqual({ text: prose, count: 0 });
  });

  test("never masks twice", () => {
    const once = redactKeyedText(`Authorization: Bearer ${OPAQUE}`).text;
    expect(redactKeyedText(once)).toEqual({ text: once, count: 0 });
  });
});

describe("url userinfo", () => {
  test("masks the whole userinfo a clone error quotes back, keeping the host readable", () => {
    const out = maskUserinfo(`fatal: unable to access 'https://x:${TOKEN}@github.com/a/b'`);
    expect(out).toContain(`https://${KEYED_MARKER}@github.com/a/b`);
    expect(out).not.toContain(TOKEN);
  });

  test("masks a token used as the user name", () => {
    expect(maskUserinfo(`https://${OPAQUE}@github.com/a/b`)).toBe(
      `https://${KEYED_MARKER}@github.com/a/b`,
    );
  });

  test("leaves a url that carries no userinfo, and never masks twice", () => {
    expect(maskUserinfo("https://github.com/a/b")).toBe("https://github.com/a/b");
    const once = maskUserinfo(`postgres://app:${"pass"}@db:5432/app`);
    expect(maskUserinfo(once)).toBe(once);
  });
});

describe("redactText", () => {
  test("applies every free-text pass", () => {
    const out = redactText(
      `Authorization: Bearer ${OPAQUE}\nclone https://${OPAQUE}@github.com/a/b\nDB_PASSWORD=hunter22`,
    );
    expect(out).not.toContain(OPAQUE);
    expect(out).not.toContain("hunter22");
    expect(out).toContain("github.com/a/b");
  });
});

describe("redactKeyedValue", () => {
  test("masks a secret key's whole subtree and scans every other string", () => {
    const out = redactKeyedValue({
      apiKey: "anything",
      nested: { password: { a: 1 } },
      max_tokens: 4096,
      note: "export DB_PASSWORD=hunter22",
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe(KEYED_MARKER);
    expect((out.nested as Record<string, unknown>).password).toBe(KEYED_MARKER);
    expect(out.max_tokens).toBe(4096);
    expect(out.note).toBe(`export DB_PASSWORD=${KEYED_MARKER}`);
  });

  test("scans strings under ordinary keys for headers and userinfo", () => {
    const out = redactKeyedValue({
      request: `GET / HTTP/1.1\r\nAuthorization: token ${OPAQUE}\r\n`,
      remote: `https://${OPAQUE}@github.com/a/b`,
    });
    expect(JSON.stringify(out)).not.toContain(OPAQUE);
  });

  test("walks arrays and withholds past the depth budget rather than recursing", () => {
    expect(redactKeyedValue([{ token: "abcdefgh" }, "plain"])).toEqual([
      { token: KEYED_MARKER },
      "plain",
    ]);
    let deep: unknown = "leaf";
    for (let index = 0; index < 20; index += 1) deep = { deep };
    expect(JSON.stringify(redactKeyedValue(deep))).toContain("[WITHHELD:budget/depth]");
  });

  test("withholds a value it cannot walk rather than taking the caller down", () => {
    const hostile = {
      get boom(): string {
        throw new Error("getter");
      },
    };
    expect(redactKeyedValue(hostile)).toBe("[WITHHELD:scrubber-error]");
  });
});

describe("masking long input", () => {
  test("takes linear time on text built to make a backtracking pattern stall", () => {
    const hostile = `${"a".repeat(200_000)}://${"b".repeat(200_000)}`;
    const started = Date.now();
    expect(maskUserinfo(hostile)).toBe(hostile);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("takes linear time on long runs of scheme words and header prefixes", () => {
    const hostile = `${"bearer ".repeat(50_000)}${"Authorization: ".repeat(20_000)}`;
    const started = Date.now();
    redactKeyedText(hostile);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
