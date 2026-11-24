import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test as base } from "#test/kit/fixtures.ts";

const ACME = join(import.meta.dirname, "..", "..", "..", "examples", "acme-registry");

interface Received {
  path: string | undefined;
  type: string | undefined;
  key: string | undefined;
  body: Buffer;
}

/** An OTLP endpoint on a free loopback port that keeps every request it is sent. */
async function endpoint(): Promise<{ url: string; received: Received[]; server: Server }> {
  const received: Received[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        path: request.url,
        type: request.headers["content-type"],
        key: request.headers["x-api-key"] as string | undefined,
        body: Buffer.concat(chunks),
      });
      response.writeHead(200, { "content-type": "application/x-protobuf" }).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, received, server };
}

/** A copy of the acme example whose registry.json asks for usage at `otlp`. */
async function registryAsking(root: string, otlp: string): Promise<string> {
  const at = join(root, "acme");
  await cp(ACME, at, { recursive: true });
  await askFor(at, otlp);
  return at;
}

async function askFor(
  registry: string,
  otlp: string,
  more: Record<string, string> = {},
): Promise<void> {
  const path = join(registry, "registry.json");
  const document = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...document, usage: { otlp, ...more } }, null, 2));
}

/** One line of a Claude Code transcript saying the skill in `folder` was loaded. */
function loaded(folder: string, turn: string, cwd: string, by: "model" | "person"): string {
  return JSON.stringify({
    type: "user",
    isMeta: true,
    promptId: turn,
    sessionId: "session-1",
    timestamp: new Date().toISOString(),
    cwd,
    ...(by === "model" ? { sourceToolUseID: `toolu_${turn}` } : {}),
    message: {
      role: "user",
      content: [
        { type: "text", text: `Base directory for this skill: ${folder}\n\nSecret prompt text.` },
      ],
    },
  });
}

const test = base.extend("usage", async ({ project, home: { dir: home }, tmp }, { onCleanup }) => {
  const otlp = await endpoint();
  onCleanup(() => new Promise<void>((done) => otlp.server.close(() => done())));
  const registry = await registryAsking(tmp, otlp.url);
  await mkdir(join(project, ".registry"), { recursive: true });
  await writeFile(
    join(project, ".registry", "manifest.yml"),
    `registries:\n  acme: ${registry}\nartifacts:\n  - ref: acme/engineering/skill/pr-review\n`,
  );
  const sessions = join(home, ".claude", "projects", "-work-app");
  await mkdir(sessions, { recursive: true });
  return {
    otlp,
    registry,
    transcript: join(sessions, "session-1.jsonl"),
    skill: join(project, ".claude", "skills", "pr-review"),
  };
});

describe("aireg usage", () => {
  test("counts runs, sends them only once you agree, and never sends the conversation", async ({
    aireg,
    project,
    usage,
  }) => {
    expect((await aireg(["install", "--for", "claude-code"])).code).toBe(0);
    const { transcript, skill, otlp } = usage;

    // Two loads in one turn are one run; a line still being written is not read yet.
    await writeFile(
      transcript,
      `${loaded(skill, "t1", project, "model")}\n${loaded(skill, "t1", project, "model")}\n${loaded(skill, "t2", project, "person")}`,
    );
    const counted = await aireg(["usage", "--json"]);
    expect(counted.code, counted.stderr).toBe(0);
    expect(counted.json().data).toMatchObject({
      artifacts: [
        {
          registry: "acme",
          ref: "engineering/skill/pr-review@1.2.0",
          runs: 1,
          byYou: 0,
          targets: ["claude-code"],
        },
      ],
      sharing: [],
    });

    // Finishing the line counts it; counting again adds nothing.
    await appendFile(transcript, "\n");
    expect((await aireg(["usage", "--json"])).json().data).toMatchObject({
      artifacts: [{ runs: 2, byYou: 1 }],
    });

    // Nothing is sent before you agree, and what was counted before stays here.
    expect((await aireg(["usage", "send", "--json"])).json().data).toEqual({ registries: [] });
    const shared = await aireg(["usage", "share", "acme", "--json"]);
    expect(shared.code, shared.stderr).toBe(0);
    expect(shared.json().data).toEqual({
      registry: "acme",
      otlp: otlp.url,
      sharing: true,
      reporter: "pseudonym",
      as: null,
    });
    expect((await aireg(["usage", "send", "--json"])).json().data).toMatchObject({
      registries: [{ registry: "acme", sent: 0, pending: 0, stopped: null }],
    });
    expect(otlp.received).toEqual([]);

    // A run after you agreed is sent once, as protobuf, with the header you set.
    await appendFile(transcript, `${loaded(skill, "t3", project, "model")}\n`);
    const sent = await aireg(["usage", "send", "--json"], {
      env: {
        AIREG_USAGE_HEADERS_ACME: "x-api-key=k%3D1",
        AIREG_USAGE_HEADERS_TOOLS: "x-api-key=other",
      },
    });
    expect(sent.json().data).toMatchObject({
      registries: [{ sent: 1, pending: 0, stopped: null }],
    });
    expect((await aireg(["usage", "send", "--json"])).json().data).toMatchObject({
      registries: [{ sent: 0, pending: 0 }],
    });
    expect(otlp.received).toHaveLength(1);
    const [request] = otlp.received;
    expect(request).toMatchObject({
      path: "/v1/traces",
      type: "application/x-protobuf",
      key: "k=1",
    });
    const body = request?.body.toString("latin1") ?? "";
    for (const text of [
      "registry.artifact.run",
      "engineering/skill/pr-review@1.2.0",
      "claude-code",
      "acme",
    ]) {
      expect(body).toContain(text);
    }
    for (const secret of ["Secret prompt text", project, "session-1"]) {
      expect(body).not.toContain(secret);
    }
  });

  test("sends nothing to an endpoint you did not agree to", async ({ aireg, project, usage }) => {
    expect((await aireg(["install", "--for", "claude-code"])).code).toBe(0);
    expect((await aireg(["usage", "share", "acme", "--json"])).code).toBe(0);
    await askFor(usage.registry, "https://elsewhere.example");
    await writeFile(usage.transcript, `${loaded(usage.skill, "t1", project, "model")}\n`);

    const sent = await aireg(["usage", "send", "--json"]);
    expect(sent.code).toBe(1);
    expect(sent.json()).toMatchObject({
      ok: false,
      data: { registries: [{ registry: "acme", sent: 0, pending: 1 }] },
    });
    expect(JSON.stringify(sent.json().data)).toContain("which you have not agreed to");
    expect(usage.otlp.received).toEqual([]);
  });

  test("asks again when the registry wants finer times, and keeps unsent runs when you agree again", async ({
    aireg,
    project,
    usage,
  }) => {
    expect((await aireg(["install", "--for", "claude-code"])).code).toBe(0);
    expect((await aireg(["usage", "share", "acme"])).code).toBe(0);
    await writeFile(usage.transcript, `${loaded(usage.skill, "t1", project, "model")}\n`);
    await askFor(usage.registry, usage.otlp.url, { time_precision: "second" });

    const held = await aireg(["usage", "send", "--json"]);
    expect(held.code).toBe(1);
    expect(JSON.stringify(held.json().data)).toContain("changed how runs are written");
    expect(usage.otlp.received).toEqual([]);

    // Back on the terms you agreed to, sending resumes; agreeing again to them keeps the unsent run.
    await askFor(usage.registry, usage.otlp.url);
    expect((await aireg(["usage", "share", "acme"])).code).toBe(0);
    const sent = await aireg(["usage", "send", "--json"]);
    expect(sent.json().data).toMatchObject({
      registries: [{ sent: 1, pending: 0, stopped: null }],
    });
    expect(usage.otlp.received).toHaveLength(1);
  });

  test("stops sending once you turn sharing off", async ({ aireg, project, usage }) => {
    expect((await aireg(["install", "--for", "claude-code"])).code).toBe(0);
    expect((await aireg(["usage", "share", "acme"])).code).toBe(0);
    const off = await aireg(["usage", "share", "acme", "--off", "--json"]);
    expect(off.json().data).toMatchObject({ registry: "acme", sharing: false });
    await writeFile(usage.transcript, `${loaded(usage.skill, "t1", project, "model")}\n`);
    expect((await aireg(["usage", "send", "--json"])).json().data).toEqual({ registries: [] });
    expect(usage.otlp.received).toEqual([]);
  });

  test("says when a registry you add asks for usage, and sends nothing for it", async ({
    aireg,
    tmp,
    usage,
  }) => {
    const added = await aireg(["add", usage.registry, "--for", "claude-code", "--yes"], {
      cwd: tmp,
    });
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).toContain("`aireg usage share acme` sends them");
    expect(usage.otlp.received).toEqual([]);
  });

  test("refuses to share with a registry that asks for no usage, or a name it cannot take", async ({
    aireg,
    usage,
  }) => {
    expect((await aireg(["install", "--for", "claude-code"])).code).toBe(0);
    expect((await aireg(["usage", "share", "acme", "--as", "jo"])).code).toBe(2);
    expect((await aireg(["usage", "share", "nowhere"])).code).toBe(2);
    const document = JSON.parse(await readFile(join(usage.registry, "registry.json"), "utf8"));
    const { usage: _, ...asksForNone } = document;
    await writeFile(join(usage.registry, "registry.json"), JSON.stringify(asksForNone));
    const refused = await aireg(["usage", "share", "acme", "--json"]);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toContain("does not ask for usage");
  });
});
