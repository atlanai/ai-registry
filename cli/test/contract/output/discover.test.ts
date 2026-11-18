import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv2020, type SchemaObject } from "ajv/dist/2020.js";
import { expect } from "vitest";
import { DISCOVERY_RECEIPTS_FILE } from "#core/product.ts";
import { test } from "#test/kit/fixtures.ts";
import { OUTPUT_SCHEMAS } from "./kit.ts";

// The built CLI uses a synthetic provider; no network or user credential is involved.
const PROVIDER = `globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith('https://generativelanguage.googleapis.com/v1beta/')) throw new Error('Unexpected destination');
  if (String(url).endsWith(':embedContent')) return Response.json({embedding:{values:[1,0]}});
  const body = JSON.parse(options.body);
  const choice = Object.hasOwn(body.questions.skill.criteria, 'connected') ? 'connected' : 'candidate_0';
  return Response.json({answers:{skill:{choice,confidence:0.9}}});
};`;

test("a harness can set up, index, search, hand off, score and inspect usage without a UI server", async ({
  home,
  project,
  aireg,
}) => {
  const document = JSON.parse(
    await readFile(join(OUTPUT_SCHEMAS, "discover.json"), "utf8"),
  ) as SchemaObject;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(document);
  const checked = new Set<string>();
  const invoke: typeof aireg = async (args, options) => {
    const ran = await aireg(args, options);
    if (ran.code !== 0) return ran;
    const action = args[1] ?? "status";
    const validate = ajv.getSchema(`${document.$id as string}#/$defs/${action}`);
    expect(validate?.(ran.json().data), ajv.errorsText(validate?.errors)).toBe(true);
    checked.add(action);
    return ran;
  };
  const folder = join(home.dir, ".claude", "skills", "recap");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "SKILL.md"),
    "---\nname: recap\ndescription: Summarize meeting notes for the team.\n---\nPrivate source instructions.",
  );
  const provider = join(project, "synthetic-provider.mjs");
  await writeFile(provider, PROVIDER);
  const node = ["--import", pathToFileURL(provider).href];
  const status = await invoke(["discover", "status", "--json"]);
  expect(status.code).toBe(0);
  expect(status.json()).toMatchObject({ data: { connected: false, available: ["this machine"] } });
  const setup = await invoke(["discover", "setup", "--input-stdin", "--json"], {
    node,
    input: JSON.stringify({
      key: "synthetic-key",
      consent: true,
      registries: ["this machine"],
      telemetry: true,
    }),
  });
  expect(setup.code).toBe(0);
  const index = await invoke(["discover", "index", "--json"], { node });
  expect(index.json()).toMatchObject({ ok: true, data: { message: "Search index is ready." } });
  const search = await invoke(["discover", "search", "--input-stdin", "--json"], {
    node,
    input: JSON.stringify({ query: "synthetic-private-task" }),
  });
  expect(search.code).toBe(0);
  expect(search.json()).toMatchObject({
    data: { status: "recommended", selected: { name: "recap" } },
  });
  const id = search.json<{ requestId: string }>().data?.requestId ?? "";
  expect((await invoke(["discover", "handoff", id, "--json"])).json()).toMatchObject({
    data: { handoff: { skill: { name: "recap" } } },
  });
  expect((await invoke(["discover", "handoff", id, "--json"])).code).toBe(0);
  expect((await invoke(["discover", "feedback", id, "helpful", "--json"])).code).toBe(0);
  expect((await invoke(["discover", "feedback", id, "helpful", "--json"])).code).not.toBe(0);
  const usage = (await invoke(["discover", "usage", "--json"])).json<{
    events: { type: string }[];
  }>();
  expect(usage.data?.events.map((e) => e.type)).toEqual([
    "search",
    "recommendation",
    "handoff",
    "feedback",
  ]);
  const receipts = await readFile(join(home.env.AIREG_HOME ?? "", DISCOVERY_RECEIPTS_FILE), "utf8");
  expect(receipts).not.toContain("synthetic-private-task");
  expect(receipts).not.toContain("synthetic-key");
  expect(receipts).not.toContain("Summarize meeting");
  expect(
    (
      await invoke(["discover", "score", "--input-stdin", "--json"], {
        input: JSON.stringify({ markdown: "# Example\nExample skill." }),
      })
    ).json(),
  ).toMatchObject({ data: { status: "scored", safety: "not-assessed" } });
  // Removing a source must not block snapshot search or local telemetry. Handoff must fail.
  await rename(folder, `${folder}-moved`);
  const offline = await invoke(["discover", "search", "recap notes", "--json"], { node });
  expect(offline.code).toBe(0);
  const offlineId = offline.json<{ requestId: string }>().data?.requestId ?? "";
  expect((await invoke(["discover", "usage", "--json"])).code).toBe(0);
  expect((await invoke(["discover", "handoff", offlineId, "--json"])).code).not.toBe(0);
  await rename(`${folder}-moved`, folder);
  // A body-only edit (same name/description) must also reject the receipt.
  await writeFile(
    join(folder, "SKILL.md"),
    "---\nname: recap\ndescription: Summarize meeting notes for the team.\n---\nChanged instructions.",
  );
  expect((await invoke(["discover", "handoff", offlineId, "--json"])).code).not.toBe(0);
  expect((await invoke(["discover", "telemetry", "off", "--json"])).code).toBe(0);
  expect((await invoke(["discover", "clear", "--json"])).code).toBe(0);
  expect((await invoke(["discover", "disconnect", "--json"])).code).toBe(0);
  expect((await invoke(["discover", "handoff", id, "--json"])).code).not.toBe(0);
  expect([...checked].sort()).toEqual(Object.keys(document.$defs as object).sort());
});

test("invalid stdin is redacted and existing search is not repurposed", async ({ aireg }) => {
  const invalid = await aireg(["discover", "setup", "--input-stdin", "--json"], {
    input: '{"key":"synthetic-private-value", broken',
  });
  expect(invalid.code).not.toBe(0);
  expect(invalid.stdout + invalid.stderr).not.toContain("synthetic-private-value");
  expect((await aireg(["search", "--help"])).stdout).not.toContain("Gemini");
  expect((await aireg(["discover", "search", "--help"])).code).toBe(0);
});
