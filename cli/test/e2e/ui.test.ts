import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import type { UiEvent } from "#cli/ui/protocol.ts";
import { marketplace } from "#test/kit/builders/layouts.ts";
import { test } from "#test/kit/fixtures.ts";
import { listen, pageHeaders, rpc, send, serveUi, session } from "#test/kit/ui.ts";

const CLEAN_EXIT = process.platform === "win32" ? null : 0;

const ACME = join(import.meta.dirname, "..", "..", "..", "examples", "acme-registry");

const ended = (runId: string) => (event: UiEvent) =>
  event.type === "run.event" && event.eventType === "run.finished" && event.runId === runId;

describe("aireg ui", () => {
  test("refuses what a page on another site could send", async ({ home, project }) => {
    const ui = await serveUi(home, project);
    try {
      const page = await send(ui.port, "/");
      expect(page.status).toBe(200);
      expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(page.headers["x-frame-options"]).toBe("DENY");
      expect(page.headers["cache-control"]).toBe("no-cache");

      const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "state.snapshot", params: {} });
      expect(
        (await send(ui.port, "/rpc", { method: "POST", headers: pageHeaders(ui, {}), body: call }))
          .status,
      ).toBe(401);
      expect((await send(ui.port, "/events")).status).toBe(401);
      const wrong = await send(ui.port, "/session", {
        method: "POST",
        headers: pageHeaders(ui, {}),
        body: JSON.stringify({ token: "x".repeat(43) }),
      });
      expect(wrong.status).toBe(401);
      expect(wrong.headers["set-cookie"]).toBeUndefined();

      const cookie = await session(ui);
      expect(cookie.cookie).toMatch(/^aireg-ui-\d+=/);
      const foreign = await send(ui.port, "/rpc", {
        method: "POST",
        headers: { ...pageHeaders(ui, cookie), origin: "https://evil.example" },
        body: call,
      });
      expect(foreign.status).toBe(403);
      const rebound = await send(ui.port, "/rpc", {
        method: "POST",
        headers: { ...pageHeaders(ui, cookie), host: "evil.example" },
        body: call,
      });
      expect(rebound.status).toBe(421);
      // A body the server drops unread would reset the connection under the answer, often enough.
      for (let attempt = 0; attempt < 10; attempt++) {
        const huge = await send(ui.port, "/rpc", {
          method: "POST",
          headers: pageHeaders(ui, cookie),
          body: "x".repeat(2_000_000),
        });
        expect(huge.status).toBe(413);
      }
      expect((await rpc(ui, cookie, "state.snapshot")).result?.scope).toBe("user");
    } finally {
      // SIGINT lets the server close and exit 0; Windows has no signals and ends the process.
      expect(await ui.stop()).toBe(CLEAN_EXIT);
    }
  });

  test("lists what each registry publishes, marked with what is installed", async ({
    home,
    project,
    aireg,
  }) => {
    expect((await aireg(["add", "-g", ACME, "--select", "pr-review", "--yes"])).code).toBe(0);
    const ui = await serveUi(home, project);
    try {
      const auth = await session(ui);
      // A catalog not read within the UI's short wait comes back loading, so ask until it is read.
      const state = await vi.waitFor(
        async () => {
          const snapshot = (await rpc(ui, auth, "state.snapshot")).result;
          expect(snapshot?.registries.some((registry) => registry.loading)).toBe(false);
          return snapshot;
        },
        { timeout: 10_000, interval: 100 },
      );
      const byName = Object.fromEntries((state?.artifacts ?? []).map((a) => [a.name, a]));
      expect(byName["pr-review"]).toMatchObject({ registry: "acme", state: "ok" });
      expect(byName.reviewer).toMatchObject({ registry: "acme", state: "available" });
      expect(byName["review-metrics"]).toMatchObject({
        kind: "semantic_model",
        state: "available",
      });
      expect(state?.registries).toEqual([
        // The example registry's skill, agent, semantic model and MCP server.
        expect.objectContaining({ name: "acme", count: 4, installed: 1 }),
      ]);
      // No row says where it is on disk beyond what a person reads under `~`.
      expect(JSON.stringify(state)).not.toContain(home.dir);

      const installed = await rpc(ui, auth, "artifact.file", {
        key: byName["pr-review"]?.key ?? "",
      });
      expect(installed.result).toMatchObject({ from: "installed" });
      expect(installed.result?.text).toContain("name: pr-review");
      const served = await rpc(ui, auth, "artifact.file", { key: byName.reviewer?.key ?? "" });
      expect(served.result).toMatchObject({ from: "registry" });
      expect(served.result?.text).toContain("reviewer");
      const outside = await rpc(ui, auth, "artifact.file", { key: "../../.ssh/id_rsa" });
      expect(outside.error?.message).toBe("No artifact by that name.");
    } finally {
      await ui.stop();
    }
  });

  test("leaves unmanaged local skills untouched", async ({ home, project }) => {
    const folder = join(home.dir, ".claude", "skills", "local-example");
    await mkdir(folder, { recursive: true });
    const markdown =
      "---\nname: local-example\ndescription: Local fixture\n---\nKeep this source.\n";
    await writeFile(join(folder, "SKILL.md"), markdown);
    const ui = await serveUi(home, project);
    try {
      const auth = await session(ui);
      const local = (await rpc(ui, auth, "state.snapshot")).result?.artifacts.find(
        (item) => item.name === "local-example",
      );
      expect(local).toMatchObject({ removable: false });
      const refused = await rpc(ui, auth, "remove.start", { key: local?.key ?? "" });
      expect(refused.error?.message).toContain("not managed by aireg");
      expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe(markdown);
    } finally {
      await ui.stop();
    }
  });

  test("installs only what a plan previewed, streams it, and says when state moved", async ({
    home,
    project,
  }) => {
    const ui = await serveUi(home, project);
    try {
      const auth = await session(ui);
      const events = await listen(ui, auth);
      expect(
        (await rpc(ui, auth, "install.apply", { planId: "never-made", trust: [] })).error?.message,
      ).toContain("expired");
      const plan = (await rpc(ui, auth, "install.plan", { source: ACME, select: ["pr-review"] }))
        .result;
      expect(plan?.changes).toEqual([
        expect.objectContaining({ name: "pr-review", action: "install" }),
      ]);
      expect(plan?.trustNeeded).toEqual([]);
      expect(plan?.command).toContain("--select=pr-review");

      const run = (await rpc(ui, auth, "install.apply", { planId: plan?.planId ?? "", trust: [] }))
        .result;
      expect(run?.command).toBe(plan?.command);
      expect(await events.next(ended(run?.runId ?? ""))).toMatchObject({
        data: { ok: true, exitCode: 0 },
      });
      expect(
        events.events.some(
          (e) => e.type === "run.event" && e.eventType === "run.output" && e.runId === run?.runId,
        ),
      ).toBe(true);
      await events.next((e) => e.type === "state.changed");
      // A plan acts once.
      expect(
        (await rpc(ui, auth, "install.apply", { planId: plan?.planId ?? "", trust: [] })).error,
      ).toBeDefined();

      const pr = (await rpc(ui, auth, "state.snapshot")).result?.artifacts.find(
        (a) => a.name === "pr-review",
      );
      expect(pr).toMatchObject({ state: "ok", removable: true });
      const removing = (await rpc(ui, auth, "remove.start", { key: pr?.key ?? "" })).result;
      expect(await events.next(ended(removing?.runId ?? ""))).toMatchObject({ data: { ok: true } });
      const after = (await rpc(ui, auth, "state.snapshot")).result?.artifacts.find(
        (a) => a.name === "pr-review",
      );
      expect(after).toMatchObject({ state: "available" });

      const doctor = (await rpc(ui, auth, "doctor.run")).result;
      expect(doctor?.checks.length).toBeGreaterThan(0);
      const sync = (await rpc(ui, auth, "sync.start")).result;
      expect(await events.next(ended(sync?.runId ?? ""))).toMatchObject({ data: { ok: true } });
      expect((await rpc(ui, auth, "run.cancel", { runId: sync?.runId ?? "" })).result).toEqual({
        cancelled: false,
      });
      events.close();
    } finally {
      await ui.stop();
    }
  });

  test("installs a plugin that runs as you only with the trust its plan asked for", async ({
    home,
    project,
    tmp,
  }) => {
    const mkt = await marketplace(join(tmp, "mkt")).write();
    const ui = await serveUi(home, project);
    try {
      const auth = await session(ui);
      const events = await listen(ui, auth);
      const plan = (await rpc(ui, auth, "install.plan", { source: mkt, select: ["deploy-kit"] }))
        .result;
      expect(plan?.trustNeeded).toEqual([
        expect.objectContaining({ plugin: "deploy-kit", carries: expect.any(Array) }),
      ]);
      const stray = await rpc(ui, auth, "install.apply", {
        planId: plan?.planId ?? "",
        trust: ["deploy-kit", "other"],
      });
      expect(stray.error?.message).toContain("does not need trust for other");
      const run = (
        await rpc(ui, auth, "install.apply", { planId: plan?.planId ?? "", trust: ["deploy-kit"] })
      ).result;
      expect(run?.command).toContain("--trust=deploy-kit");
      expect(await events.next(ended(run?.runId ?? ""))).toMatchObject({ data: { ok: true } });
      const kit = (await rpc(ui, auth, "state.snapshot")).result?.artifacts.find(
        (a) => a.name === "deploy-kit",
      );
      expect(kit?.state).not.toBe("available");
      events.close();
    } finally {
      await ui.stop();
    }
  });

  test("reopens the server for the same folder and starts another for a different one", async ({
    home,
    project,
    tmp,
  }) => {
    const ui = await serveUi(home, project);
    try {
      const again = await serveUi(home, project);
      expect(again.port).toBe(ui.port);
      expect(again.token === ui.token).toBe(true);
      // A launch that reopened a server exits on its own, with 0 on every platform.
      expect(await again.exited).toBe(0);
      const elsewhere = join(tmp, "elsewhere");
      await mkdir(elsewhere);
      const other = await serveUi(home, elsewhere);
      try {
        expect(other.port).not.toBe(ui.port);
      } finally {
        await other.stop();
      }
    } finally {
      await ui.stop();
    }
  });
});
