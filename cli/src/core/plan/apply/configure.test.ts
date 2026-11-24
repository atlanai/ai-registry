import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { roots } from "#core/store/paths.ts";
import { claudeCode } from "#targets/claude-code.ts";
import { test } from "#test/kit/fixtures.ts";
import { configure, unconfigure } from "./configure.ts";
import type { ActionOf, Run } from "./run.ts";

const mapping = claudeCode.kinds.mcp_server as ActionOf<"configure">["mapping"];
const AT = ["mcpServers", "srv"];

const SERVER = {
  packages: [
    {
      registryType: "npm",
      identifier: "srv",
      version: "1.0.0",
      transport: { type: "stdio" },
      environmentVariables: [{ name: "TOKEN", isSecret: true }],
    },
  ],
};

async function setup(tmp: string) {
  const from = join(tmp, "copy");
  await mkdir(from, { recursive: true });
  await writeFile(join(from, "server.json"), JSON.stringify(SERVER));
  const run = {
    inputs: { roots: roots("project", tmp) },
    results: { claims: new Map() },
  } as unknown as Run;
  const to = join(tmp, ".mcp.json");
  const action = (extra: Partial<ActionOf<"configure">> = {}): ActionOf<"configure"> => ({
    kind: "configure",
    name: "srv",
    target: "claude-code",
    to,
    at: AT,
    mapping,
    from,
    server: undefined,
    ...extra,
  });
  const json = async () => JSON.parse(await readFile(to, "utf8"));
  return { run, to, action, json };
}

describe("configure", () => {
  test("writes the entry beside a person's own, with the secret as a reference", async ({
    tmp,
  }) => {
    const { run, to, action, json } = await setup(tmp);
    await writeFile(to, JSON.stringify({ mcpServers: { mine: { command: "x" } } }));
    const done = await configure(run, action());
    expect(done.written).toBe(true);
    expect(done.receipt).toMatchObject({ file: ".mcp.json", format: "json", at: AT });
    expect(await json()).toEqual({
      mcpServers: {
        mine: { command: "x" },
        srv: {
          type: "stdio",
          command: "npx",
          args: ["-y", "srv@1.0.0"],
          env: { TOKEN: `\${TOKEN}` },
        },
      },
    });
    const { receipt } = done;
    if (receipt === undefined) throw new Error("no receipt");
    expect(await configure(run, action({ receipt }))).toEqual({ written: false, receipt });
  });

  test("leaves an entry it did not write, and one edited since, unless forced", async ({ tmp }) => {
    const { run, to, action, json } = await setup(tmp);
    await writeFile(to, JSON.stringify({ mcpServers: { srv: { command: "theirs" } } }));
    const foreign = await configure(run, action());
    expect(foreign.written).toBe(false);
    expect(foreign.receipt).toBeUndefined();
    expect(foreign.kept?.reason).toContain("`as`");

    const receipt = { target: "claude-code", file: ".mcp.json", format: "json" as const, at: AT };
    const edited = await configure(run, action({ receipt: { ...receipt, digest: "0" } }));
    expect(edited.kept?.reason).toContain("edited");
    expect(await json()).toEqual({ mcpServers: { srv: { command: "theirs" } } });

    const forced = await configure(
      run,
      action({ receipt: { ...receipt, digest: "0" }, force: true }),
    );
    expect(forced.written).toBe(true);
    expect((await json()).mcpServers.srv.command).toBe("npx");
  });

  test("says why when the server cannot run where the target reaches it", async ({ tmp }) => {
    const { run, action } = await setup(tmp);
    const remoteOnly = { ...mapping, transports: ["sse" as const] };
    const done = await configure(run, action({ mapping: remoteOnly }));
    expect(done.unrendered?.reason).toContain("does not load");
  });
});

describe("an entry two targets read", () => {
  test("is written once when they agree, and left to the first when they differ", async ({
    tmp,
  }) => {
    const { run, action, json } = await setup(tmp);
    expect((await configure(run, action())).written).toBe(true);
    const same = await configure(run, action({ target: "github-copilot" }));
    expect(same).toMatchObject({ written: false, receipt: { target: "github-copilot" } });
    const narrowed = await configure(
      run,
      action({
        target: "github-copilot",
        mapping: {
          ...mapping,
          codec: {
            id: "mcp-json",
            secret: { prefix: "${", suffix: "}" },
            tools: { allow: ["tools"] },
          },
        },
        server: { tools: { allow: ["a"] } },
      }),
    );
    expect(narrowed.unrendered?.reason).toContain("claude-code");
    expect(Object.keys((await json()).mcpServers.srv)).not.toContain("tools");
  });
});

describe("denied tools", () => {
  test("go beside a person's own rules, and only aireg's are taken back", async ({ tmp }) => {
    const { run, action } = await setup(tmp);
    const settings = join(tmp, ".claude", "settings.json");
    await mkdir(join(tmp, ".claude"));
    await writeFile(settings, JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }));
    const at = ["permissions", "deny"];
    const done = await configure(
      run,
      action({
        server: { tools: { deny: ["drop"] } },
        deny: { to: settings, at, items: ["mcp__srv__drop"] },
      }),
    );
    expect(done.denied).toMatchObject({ file: ".claude/settings.json", items: ["mcp__srv__drop"] });
    const read = async () => JSON.parse(await readFile(settings, "utf8"));
    expect((await read()).permissions.deny).toEqual(["Bash(rm:*)", "mcp__srv__drop"]);
    const receipt = done.denied;
    if (receipt === undefined) throw new Error("no receipt");
    const take = { kind: "unconfigure" as const, name: "srv", target: "claude-code" };
    await unconfigure(run, { ...take, to: settings, format: "json", receipt });
    expect(await read()).toEqual({ permissions: { deny: ["Bash(rm:*)"] } });
  });

  test("allowing only some tools leaves Claude Code out", async ({ tmp }) => {
    const { run, action } = await setup(tmp);
    const done = await configure(run, action({ server: { tools: { allow: ["a"] } } }));
    expect(done.unrendered?.reason).toContain("allows only some tools");
  });
});

test("leaves a file it cannot parse, such as JSON with comments", async ({ tmp }) => {
  const { run, to, action } = await setup(tmp);
  await writeFile(to, '// mine\n{ "mcpServers": {} }\n');
  const done = await configure(run, action());
  expect(done.unrendered?.reason).toContain("comments");
  expect(await readFile(to, "utf8")).toContain("// mine");
});

describe("unconfigure", () => {
  test("removes only an unedited entry, and the file once nothing else is in it", async ({
    tmp,
  }) => {
    const { run, to, action, json } = await setup(tmp);
    await writeFile(to, JSON.stringify({ other: true }));
    const { receipt } = await configure(run, action());
    if (receipt === undefined) throw new Error("no receipt");
    const take = {
      kind: "unconfigure" as const,
      name: "srv",
      target: "claude-code",
      to,
      format: "json" as const,
      receipt,
    };

    const doc = await json();
    doc.mcpServers.srv.args.push("--edited");
    await writeFile(to, JSON.stringify(doc));
    const kept = await unconfigure(run, take);
    expect(kept.written).toBe(false);
    expect(kept.kept?.reason).toContain("edited");

    await configure(run, action({ receipt, force: true }));
    expect((await unconfigure(run, take)).written).toBe(true);
    expect(await json()).toEqual({ other: true });
  });
});
