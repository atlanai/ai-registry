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
  const run = { inputs: { roots: roots("project", tmp) } } as unknown as Run;
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
        srv: { command: "npx", args: ["-y", "srv@1.0.0"], env: { TOKEN: "${TOKEN}" } },
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
