import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { marketplace } from "#test/kit/builders/layouts.ts";
import { test } from "#test/kit/fixtures.ts";
import { send, serveUi } from "#test/kit/ui.ts";

const CLEAN_EXIT = process.platform === "win32" ? null : 0;

const ACME = join(import.meta.dirname, "..", "..", "..", "examples", "acme-registry");

interface Listed {
  key: string;
  name: string;
  state: string;
  registry: string;
}

const json = (token: string, origin: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  origin,
});

describe("aireg ui", () => {
  test("refuses what a page on another site could send", async ({ home, project }) => {
    const ui = await serveUi(home, project);
    try {
      const port = ui.printed.data.port;
      const page = await send(port, "/");
      expect(page.status).toBe(200);
      expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(page.headers["x-frame-options"]).toBe("DENY");

      expect((await send(port, "/api/artifacts")).status).toBe(401);
      const auth = { authorization: `Bearer ${ui.token}` };
      expect(
        (await send(port, "/api/artifacts", { headers: { ...auth, host: "evil.example" } })).status,
      ).toBe(421);
      const form = await send(port, "/api/add", {
        method: "POST",
        headers: { "content-type": "text/plain", origin: "https://evil.example" },
        body: JSON.stringify({ source: "x", trust: true }),
      });
      expect(form.status).toBe(401);
      const foreign = await send(port, "/api/retire", {
        method: "POST",
        headers: json(ui.token, "https://evil.example"),
        body: JSON.stringify({ key: "x" }),
      });
      expect(foreign.status).toBe(403);
      const huge = await send(port, "/api/add", {
        method: "POST",
        headers: json(ui.token, ui.origin),
        body: JSON.stringify({ source: "x".repeat(70_000) }),
      });
      expect(huge.status).toBe(413);
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
      const port = ui.printed.data.port;
      const auth = { authorization: `Bearer ${ui.token}` };
      const listed = JSON.parse((await send(port, "/api/artifacts", { headers: auth })).body).data;
      const byName = Object.fromEntries((listed.artifacts as Listed[]).map((a) => [a.name, a]));
      expect(byName["pr-review"]).toMatchObject({ registry: "acme", state: "ok" });
      expect(byName.reviewer).toMatchObject({ registry: "acme", state: "available" });
      expect(listed.registries).toEqual([
        expect.objectContaining({ name: "acme", count: 2, installed: 1 }),
      ]);
      // No row says where it is on disk beyond what a person reads under `~`.
      expect(JSON.stringify(listed)).not.toContain(home.dir);

      const installed = await send(
        port,
        `/api/skill?key=${encodeURIComponent(byName["pr-review"]?.key ?? "")}`,
        { headers: auth },
      );
      expect(JSON.parse(installed.body).data.markdown).toContain("name: pr-review");
      const served = await send(
        port,
        `/api/skill?key=${encodeURIComponent(byName.reviewer?.key ?? "")}`,
        { headers: auth },
      );
      expect(JSON.parse(served.body).data.markdown).toContain("reviewer");
      const outside = await send(
        port,
        `/api/skill?key=${encodeURIComponent("../../.ssh/id_rsa")}`,
        { headers: auth },
      );
      expect(outside.status).toBe(404);
    } finally {
      await ui.stop();
    }
  });

  test("takes names only as data, and trust only from a dry run", async ({ home, project }) => {
    const ui = await serveUi(home, project);
    try {
      const port = ui.printed.data.port;
      const post = async (path: string, body: object) =>
        JSON.parse(
          (
            await send(port, path, {
              method: "POST",
              headers: json(ui.token, ui.origin),
              body: JSON.stringify(body),
            })
          ).body,
        );
      expect((await post("/api/retire", { key: "--all" })).error).toBe("No artifact by that name.");
      // A name that is not one path segment is refused before anything is looked up.
      expect((await post("/api/restore", { id: ".." })).error).toBe("Name one retired folder.");
      expect((await post("/api/restore", { id: "a/b" })).error).toBe("Name one retired folder.");
      expect((await post("/api/restore", { id: "nothing-here" })).error).toBe(
        "That retired folder does not say where it came from.",
      );
      expect((await post("/api/add", { source: "--force" })).ok).toBe(false);
      expect((await post("/api/add", { source: ACME, select: ["--all"] })).ok).toBe(false);
      expect(
        (await post("/api/add", { source: ACME, trust: true, trustName: "evil" })).error,
      ).toContain("dry run");
      expect((await post("/api/add", { source: "https://me:token@example.com/r" })).ok).toBe(false);
    } finally {
      await ui.stop();
    }
  });

  test("retires a skill written here aside, and restores it where it was", async ({
    home,
    project,
  }) => {
    const folder = join(home.dir, ".claude", "skills", "notes");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "SKILL.md"),
      "---\nname: notes\ndescription: Notes.\n---\n# Notes\n",
    );
    const ui = await serveUi(home, project);
    try {
      const port = ui.printed.data.port;
      const auth = { authorization: `Bearer ${ui.token}` };
      const post = async (path: string, body: object) =>
        JSON.parse(
          (
            await send(port, path, {
              method: "POST",
              headers: json(ui.token, ui.origin),
              body: JSON.stringify(body),
            })
          ).body,
        );
      const listed = JSON.parse((await send(port, "/api/artifacts", { headers: auth })).body).data
        .artifacts as Listed[];
      const notes = listed.find((a) => a.name === "notes");
      expect(notes).toMatchObject({ registry: "this machine", state: "unpublished" });

      expect((await post("/api/retire", { key: notes?.key, dryRun: true })).message).toMatch(
        /^Would move/,
      );
      expect(await readdir(join(home.dir, ".claude", "skills"))).toContain("notes");
      expect((await post("/api/retire", { key: notes?.key })).ok).toBe(true);
      expect(await readdir(join(home.dir, ".claude", "skills"))).not.toContain("notes");

      const retired = JSON.parse(
        (await send(port, "/api/retired", { headers: auth })).body,
      ).retired;
      expect(retired).toEqual([
        expect.objectContaining({ name: "notes", from: "~/.claude/skills/notes" }),
      ]);
      expect((await post("/api/restore", { id: retired[0].id })).ok).toBe(true);
      expect(await readdir(join(home.dir, ".claude", "skills"))).toContain("notes");
    } finally {
      await ui.stop();
    }
  });

  test("installs, retires and reads state through the page, as the CLI would", async ({
    home,
    project,
  }) => {
    const ui = await serveUi(home, project);
    try {
      const port = ui.printed.data.port;
      const auth = { authorization: `Bearer ${ui.token}` };
      const post = async (path: string, body: object) =>
        JSON.parse(
          (
            await send(port, path, {
              method: "POST",
              headers: json(ui.token, ui.origin),
              body: JSON.stringify(body),
            })
          ).body,
        );

      const plan = await post("/api/add", { source: ACME, select: "pr-review", dryRun: true });
      expect(plan).toMatchObject({ ok: true, dryRun: true });
      expect(plan.output).toContain("Would install pr-review.");
      const added = await post("/api/add", { source: ACME, select: "pr-review" });
      expect(added).toMatchObject({ ok: true, installed: ["pr-review"] });

      const listed = JSON.parse((await send(port, "/api/artifacts", { headers: auth })).body).data
        .artifacts as Listed[];
      const pr = listed.find((a) => a.name === "pr-review");
      expect(pr).toMatchObject({ state: "ok", registry: "acme" });
      const would = await post("/api/retire", { key: pr?.key, dryRun: true });
      expect(would).toMatchObject({ ok: true, dryRun: true });
      expect((await post("/api/retire", { key: pr?.key })).ok).toBe(true);
      const after = JSON.parse((await send(port, "/api/artifacts", { headers: auth })).body).data
        .artifacts as Listed[];
      expect(after.find((a) => a.name === "pr-review")).toMatchObject({ state: "available" });

      const consoled = JSON.parse((await send(port, "/api/console", { headers: auth })).body);
      expect(consoled.data).toMatchObject({
        scope: "user",
        jobs: expect.any(Array),
        runs: expect.any(Array),
      });
      const doctor = JSON.parse((await send(port, "/api/doctor", { headers: auth })).body);
      expect(doctor.data.checks.length).toBeGreaterThan(0);
      expect((await post("/api/sync", {})).ok).toBe(true);
    } finally {
      await ui.stop();
    }
  });

  test("never writes through a link a retired folder holds, and shows a restored folder at once", async ({
    home,
    project,
  }) => {
    const folder = join(home.dir, ".claude", "skills", "trap");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), "---\nname: trap\ndescription: Trap.\n---\n# Trap\n");
    const victim = join(home.dir, "victim.txt");
    await writeFile(victim, "untouched");
    await symlink(victim, join(folder, ".retired.json"));
    const ui = await serveUi(home, project);
    try {
      const port = ui.printed.data.port;
      const auth = { authorization: `Bearer ${ui.token}` };
      const post = async (path: string, body: object) =>
        JSON.parse(
          (
            await send(port, path, {
              method: "POST",
              headers: json(ui.token, ui.origin),
              body: JSON.stringify(body),
            })
          ).body,
        );
      const artifacts = async () =>
        JSON.parse((await send(port, "/api/artifacts", { headers: auth })).body).data
          .artifacts as Listed[];
      const trap = (await artifacts()).find((a) => a.name === "trap");
      expect((await post("/api/retire", { key: trap?.key })).ok).toBe(true);
      expect(await readFile(victim, "utf8")).toBe("untouched");

      const retired = JSON.parse(
        (await send(port, "/api/retired", { headers: auth })).body,
      ).retired;
      expect((await post("/api/restore", { id: retired[0].id })).ok).toBe(true);
      expect((await artifacts()).some((a) => a.name === "trap")).toBe(true);
    } finally {
      await ui.stop();
    }
  });

  test("trusts a plugin only while what it runs is what the dry run read", async ({
    home,
    project,
    tmp,
  }) => {
    const mkt = await marketplace(join(tmp, "mkt")).write();
    const ui = await serveUi(home, project);
    try {
      const port = ui.printed.data.port;
      const post = async (path: string, body: object) =>
        JSON.parse(
          (
            await send(port, path, {
              method: "POST",
              headers: json(ui.token, ui.origin),
              body: JSON.stringify(body),
            })
          ).body,
        );
      const plan = await post("/api/add", { source: mkt, dryRun: true });
      expect(plan.untrusted).toEqual(["deploy-kit"]);
      // The source changes what the plugin runs between the dry run and the click.
      await writeFile(
        join(mkt, "plugins", "deploy-kit", "hooks", "hooks.json"),
        JSON.stringify({ hooks: { SessionStart: [] } }),
      );
      const swapped = await post("/api/add", { source: mkt, trust: true, trustName: "deploy-kit" });
      expect(swapped.error).toBe(
        "What deploy-kit runs changed since the dry run, so nothing was installed.",
      );
    } finally {
      await ui.stop();
    }
  });
});
