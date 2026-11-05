import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { type Aireg, test } from "#test/kit/fixtures.ts";

interface Check {
  name: string;
  detail: string;
}

async function doctorTelemetry(aireg: Aireg, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const { data } = JSON.parse((await aireg(["doctor", "--json"], { env })).stdout);
  return (data.checks as Check[]).find((check) => check.name === "telemetry")?.detail;
}

async function arrived<T>(events: T[], count: number): Promise<void> {
  for (let waited = 0; events.length < count && waited < 10_000; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("usage events", () => {
  test("a background sender reports each command, naming no local registry", async ({
    aireg,
    tmp,
    home,
  }) => {
    const events: Record<string, string>[] = [];
    const requests: {
      method: string | undefined;
      url: string | undefined;
      type: string | undefined;
    }[] = [];
    const server = createServer((request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
        type: request.headers["content-type"],
      });
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        events.push(JSON.parse(body) as Record<string, string>);
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const env = { AIREG_TELEMETRY_URL: `http://127.0.0.1:${port}/t`, CI: "", CLAUDECODE: "1" };
      const market = join(tmp, "market");
      await registry(market).skill("acme/lint@1.0.0").agent("acme/triage@1.0.0").write();

      const first = await aireg(["registry", "add", market, "--as", "acme"], { env });
      expect(first.code).toBe(0);
      expect(first.stderr).toContain(
        "notice: aireg collects usage data to improve the CLI. Events never include your identity.",
      );
      const added = await aireg(["add", "acme/lint", "--yes"], { env });
      expect(added.code, added.stderr).toBe(0);
      expect(added.stderr).not.toContain("notice:");
      await arrived(events, 1);
      const searched = await aireg(["search", "triage"], { env });
      expect(searched.code, searched.stderr).toBe(0);
      await arrived(events, 2);
      const removed = await aireg(["remove", "lint", "-g", "--yes"], { env });
      expect(removed.code, removed.stderr).toBe(0);
      await arrived(events, 3);

      expect(events.map((event) => event.event)).toEqual(["install", "search", "remove"]);
      expect(requests).toEqual(
        Array(3).fill({ method: "POST", url: "/t", type: "application/json" }),
      );
      const [install, search, remove] = events;
      expect(install).toMatchObject({
        trigger: "add",
        sourceType: "local",
        kinds: "skill",
        agent: "claude-code",
      });
      expect(install).not.toHaveProperty("artifacts");
      expect(search).toMatchObject({ resultCount: "1" });
      expect(search).not.toHaveProperty("query");
      expect(remove).toMatchObject({ sourceType: "local", kinds: "skill" });
      expect(events.every((event) => event.id === install?.id)).toBe(true);
      expect(JSON.stringify(events)).not.toContain(home.dir);

      expect(await doctorTelemetry(aireg, env)).toMatch(/usage events on/);
      expect(await doctorTelemetry(aireg, { ...env, DO_NOT_TRACK: "1" })).toBe(
        "off, because DO_NOT_TRACK is set",
      );

      const sentBefore = events.length;
      expect((await aireg(["config", "set", "telemetry", "false"], { env })).code).toBe(0);
      expect((await aireg(["search", "lint"], { env })).code).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(events).toHaveLength(sentBefore);
      expect(await doctorTelemetry(aireg, env)).toBe(
        "off, because `aireg config` has telemetry false",
      );
    } finally {
      server.close();
    }
  });
});
