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
    const server = createServer((request, response) => {
      events.push(Object.fromEntries(new URL(request.url ?? "/", "http://c").searchParams));
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const env = { AIREG_TELEMETRY_URL: `http://127.0.0.1:${port}/t`, CI: "", CLAUDECODE: "1" };
      const market = join(tmp, "market");
      await registry(market).skill("acme/lint@1.0.0").agent("acme/triage@1.0.0").write();

      expect((await aireg(["registry", "add", market, "--as", "acme"], { env })).code).toBe(0);
      const added = await aireg(["add", "acme/lint", "--yes"], { env });
      expect(added.code, added.stderr).toBe(0);
      await arrived(events, 1);
      const searched = await aireg(["search", "triage"], { env });
      expect(searched.code, searched.stderr).toBe(0);
      await arrived(events, 2);
      const removed = await aireg(["remove", "lint", "-g", "--yes"], { env });
      expect(removed.code, removed.stderr).toBe(0);
      await arrived(events, 3);

      expect(events.map((event) => event.event)).toEqual(["install", "search", "remove"]);
      const [install, search, remove] = events;
      expect(install).toMatchObject({ sourceType: "local", kinds: "skill", agent: "claude-code" });
      expect(install).not.toHaveProperty("artifacts");
      expect(search).toMatchObject({ resultCount: "1" });
      expect(search).not.toHaveProperty("query");
      expect(remove).toMatchObject({ sourceType: "local", kinds: "skill" });
      expect(events.every((event) => event.id === install?.id)).toBe(true);
      expect(JSON.stringify(events)).not.toContain(home.dir);

      expect(await doctorTelemetry(aireg, env)).toMatch(/events on; set DO_NOT_TRACK=1/);
      expect(await doctorTelemetry(aireg, { ...env, DO_NOT_TRACK: "1" })).toBe(
        "off, because DO_NOT_TRACK is set",
      );
    } finally {
      server.close();
    }
  });
});
