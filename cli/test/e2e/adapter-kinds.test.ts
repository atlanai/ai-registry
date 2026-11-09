import { existsSync, lstatSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import { test as base } from "#test/kit/fixtures.ts";
import { lockPath, writeManifestIn } from "#test/kit/scope.ts";

const KINDS_ADAPTER = join(import.meta.dirname, "..", "fixtures", "kinds-adapter.mjs");

/** Declares a kind named like a built-in beside one of its own, which costs it both. */
const SHADOW_ADAPTER = [
  "export default {",
  "  id: 'shadow', displayName: 'Shadow', protocol: 1, artifactKinds: ['skill', 'note'],",
  "  dispatch: { hosts: ['shadow.example'] },",
  "  capabilities: { pinsSource: false },",
  "  connect: async () => ({ resolve: async () => ({ artifacts: [] }),",
  "    fetch: async () => new Uint8Array(), close: async () => {} }),",
  "  extend: { kinds: [",
  "    { name: 'note', dir: 'notes', shape: 'file', extensions: ['.md'] },",
  "    { name: 'skill', dir: 'shadow-skills', shape: 'directory' },",
  "  ] },",
  "};",
  "",
].join("\n");

const config = (adapters: Record<string, string>) =>
  [
    "schemaVersion: 1",
    "revision: 0",
    Object.keys(adapters).length === 0 ? "adapters: {}" : "adapters:",
    ...Object.entries(adapters).map(([id, path]) => `  ${id}: ${path}`),
    "accounts: []",
    "jobs: []",
    "",
  ].join("\n");

const test = base.extend("kinds", async ({ home }) => {
  await mkdir(home.aireg, { recursive: true, mode: 0o700 });
  await writeFile(join(home.aireg, "config.yml"), config({ kinds: KINDS_ADAPTER }));
  return join(home.aireg, "kinds-remote");
});

const REGISTRY = `registries:
  hosted:
    source: https://kinds.registry.localhost
    adapter: kinds
`;

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** Puts an artifact in the adapter's remote, as a publish from elsewhere would. */
async function seed(remote: string, at: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) await write(join(remote, at, path), text);
  await write(join(remote, at, "meta.json"), JSON.stringify({ version: "1.0.0" }));
}

/** The fixture adapter with its kinds replaced, loaded as aireg loads any module. */
async function variant(home: string, file: string, extend: string): Promise<string> {
  const path = join(home, file);
  await writeFile(
    path,
    `import base from ${JSON.stringify(KINDS_ADAPTER)};\nexport default { ...base, ${extend} };\n`,
  );
  return path;
}

const SERVER = (name: string) => ({
  "server.json": `{"name":"${name}","transport":"stdio"}\n`,
  "server.js": "process.stdin.resume();\n",
});

describe("kinds an adapter declares", () => {
  test("publish through exports, and are found, shown and installed where a target maps them", async ({
    aireg,
    project,
    kinds: remote,
  }) => {
    await write(join(project, "knowledge", "accounts", "index.md"), "# Accounts\n");
    await write(join(project, "knowledge", "accounts", "contracts", "routing.json"), "{}\n");
    await write(
      join(project, "prompts", "review.md"),
      "---\ndescription: Reviews a change.\n---\nReview it.\n",
    );
    await writeManifestIn(
      project,
      `${REGISTRY}exports:
  - path: knowledge/accounts
    kind: knowledge
  - path: prompts/review.md
    kind: prompt
publish:
  to: hosted/eng
`,
    );

    const planned = await aireg(["publish", "--dry-run", "--json"]);
    expect(planned.code, planned.stderr).toBe(0);
    const dry = JSON.parse(planned.stdout).data;
    expect(dry.artifacts).toEqual([
      expect.objectContaining({
        name: "accounts",
        kind: "knowledge",
        published: false,
        filesChanged: { added: ["contracts/routing.json", "index.md"], changed: [], removed: [] },
      }),
      expect.objectContaining({
        name: "review",
        kind: "prompt",
        published: false,
        filesChanged: { added: ["review.md"], changed: [], removed: [] },
      }),
    ]);
    expect(existsSync(remote)).toBe(false);

    const published = await aireg(["publish", "--yes", "--json"]);
    expect(published.code, published.stderr).toBe(0);
    expect(
      JSON.parse(published.stdout).data.artifacts.map(
        (each: { published: boolean }) => each.published,
      ),
    ).toEqual([true, true]);
    expect(
      await readFile(
        join(remote, "eng", "knowledge", "accounts", "contracts", "routing.json"),
        "utf8",
      ),
    ).toBe("{}\n");
    const meta = JSON.parse(
      await readFile(join(remote, "eng", "prompt", "review", "meta.json"), "utf8"),
    );
    expect(meta.spec).toEqual({ description: "Reviews a change.", name: "review" });

    const found = await aireg(["search", "accounts", "--kind", "knowledge", "--json"]);
    expect(found.code, found.stderr).toBe(0);
    expect(JSON.parse(found.stdout).data.matches).toEqual([
      expect.objectContaining({ address: "hosted/eng/knowledge/accounts", kind: "knowledge" }),
    ]);
    const listed = await aireg(["search", "review"]);
    expect(listed.stdout).toMatch(/eng\/review +prompt +0\.1\.0 +hosted +Reviews a change\./);
    const unknown = await aireg(["search", "x", "--kind", "widget"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain(
      'error: --kind takes plugin, skill, agent, knowledge, mcp_server or prompt, not "widget".',
    );
    const shown = await aireg(["show", "hosted/eng/knowledge/accounts"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain("# Accounts");

    const refused = await aireg(["add", "hosted/eng/knowledge/accounts", "--yes"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(
      "error: hosted/eng/knowledge/accounts is of the kind knowledge, which aireg publishes but does not install.",
    );

    const added = await aireg(["add", "hosted/eng/prompt/review", "--for", "universal", "--yes"]);
    expect(added.code, added.stderr).toBe(0);
    const placed = join(project, ".agents", "prompts", "review.md");
    expect(lstatSync(placed).isSymbolicLink()).toBe(true);
    expect(await readFile(placed, "utf8")).toContain("Review it.");
    const installed = await aireg(["list"]);
    expect(installed.stdout).toMatch(/review +prompt +0\.1\.0 +hosted +\.agents/);
  });

  test("sync leaves out a publish-only kind with a warning, installing the rest", async ({
    aireg,
    project,
    kinds: remote,
  }) => {
    await seed(remote, "eng/knowledge/accounts", { "index.md": "# Accounts\n" });
    await seed(remote, "eng/prompt/review", { "review.md": "Review it.\n" });
    await writeManifestIn(project, `${REGISTRY}targets: [universal]\nartifacts:\n  - hosted/eng\n`);
    const installed = await aireg(["install"]);
    expect(installed.code, installed.stderr).toBe(0);
    expect(installed.stderr).toContain(
      "hosted/eng/knowledge/accounts is of the kind knowledge, which aireg publishes but installs into no target, so it is left out.",
    );
    expect(existsSync(join(project, ".agents", "prompts", "review.md"))).toBe(true);
    expect(await readFile(lockPath(project), "utf8")).not.toContain("kind: knowledge");
  });

  test("keep a lockfile row of a kind no adapter declares, readable and as it is", async ({
    aireg,
    project,
    kinds: remote,
  }) => {
    await seed(remote, "eng/prompt/review", { "review.md": "Review it.\n" });
    await writeManifestIn(
      project,
      `${REGISTRY}targets: [universal]\nartifacts:\n  - hosted/eng/prompt/review\n`,
    );
    expect((await aireg(["install"])).code).toBe(0);
    const row = [
      "  gadget:",
      "    registry: hosted",
      "    id: eng/widget/gadget",
      "    name: gadget",
      "    kind: widget",
      "    namespace: eng",
      "    path: .registry/artifacts/hosted/eng/widgets/gadget",
      `    digest: sha256:${"3".repeat(64)}`,
      "    links: []",
      "",
    ].join("\n");
    const lock = `${await readFile(lockPath(project), "utf8")}${row}`;
    await writeFile(lockPath(project), lock);

    const listed = await aireg(["list"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toMatch(/gadget +widget +hosted/);
    const status = await aireg(["status", "--json"]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).data.artifacts).toContainEqual(
      expect.objectContaining({ name: "gadget", state: "ok" }),
    );
    const installed = await aireg(["install"]);
    expect(installed.code, installed.stderr).toBe(0);
    expect(installed.stderr).toContain(
      'Left "gadget" as it is: no loaded adapter declares its kind, "widget".',
    );
    expect(await readFile(lockPath(project), "utf8")).toBe(lock);
  });

  test("refuse a declaration naming a built-in kind, with a warning, and only that adapter's kinds", async ({
    aireg,
    home,
    project,
    kinds: _,
  }) => {
    await writeFile(join(home.dir, "shadow.mjs"), SHADOW_ADAPTER);
    await writeFile(
      join(home.aireg, "config.yml"),
      config({ kinds: KINDS_ADAPTER, shadow: join(home.dir, "shadow.mjs") }),
    );
    await writeManifestIn(project, REGISTRY);
    const searched = await aireg(["search", "x", "--kind", "note"]);
    expect(searched.code).toBe(2);
    expect(searched.stderr).toContain(
      'warning: The adapter "shadow" declares kinds aireg cannot use, so it adds none: "skill" is a built-in kind.',
    );
    expect(searched.stderr).toContain(
      'error: --kind takes plugin, skill, agent, knowledge, mcp_server or prompt, not "note".',
    );
  });
});

describe("addresses and scans of declared kinds", () => {
  test("refuse a typed address of a kind aireg does not know", async ({
    aireg,
    project,
    kinds: _,
  }) => {
    await writeManifestIn(project, REGISTRY);
    const added = await aireg(["add", "hosted/eng/widget/gadget", "--yes"]);
    expect(added.code).toBe(2);
    expect(added.stderr).toContain(
      'error: "widget" in "hosted/eng/widget/gadget" is not a kind aireg knows.',
    );
    expect(added.stderr).toContain(
      "hint: Use plugin, skill, agent, knowledge, mcp_server or prompt",
    );
  });

  test("never take a folder under a folder kind with no entry file as one", async ({
    aireg,
    home,
    project,
    kinds: _,
  }) => {
    const notes = `{ name: "notes", dir: "notes", shape: "directory", targets: { "claude-code": { shape: "directory", subdir: "notes" } } }`;
    const adapter = await variant(home.dir, "notes.mjs", `extend: { kinds: [${notes}] }`);
    await writeFile(join(home.aireg, "config.yml"), config({ kinds: adapter }));
    await writeManifestIn(project, REGISTRY);
    await write(join(project, ".claude", "notes", "scratch", "todo.txt"), "mine\n");
    const status = await aireg(["status", "--json"]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).data.unmanaged).toEqual([]);
  });
});

describe("installed rows of a kind no loaded adapter declares", () => {
  test("are kept byte for byte with their placements, and installed again once it is back", async ({
    aireg,
    home,
    project,
    kinds: remote,
  }) => {
    await seed(remote, "eng/prompt/review", { "review.md": "Review it.\n" });
    await seed(remote, "eng/mcp_server/tracker", SERVER("tracker"));
    await writeManifestIn(project, REGISTRY);
    const prompt = ["add", "hosted/eng/prompt/review", "--for", "universal", "--yes"];
    expect((await aireg(prompt)).code).toBe(0);
    const server = [
      "add",
      "hosted/eng/mcp_server/tracker",
      "--for",
      "claude-code",
      "--for",
      "codex",
    ];
    expect((await aireg([...server, "--yes"])).code).toBe(0);
    const lock = await readFile(lockPath(project), "utf8");
    const placed = [".agents/prompts/review.md", ".claude/mcp/tracker", ".codex/mcp/tracker"];
    const linked = () => placed.map((path) => lstatSync(join(project, path)).isSymbolicLink());
    expect(linked()).toEqual([true, true, true]);

    const configs = {
      gone: config({}),
      bare: config({ kinds: await variant(home.dir, "bare.mjs", "extend: {}") }),
      back: config({ kinds: KINDS_ADAPTER }),
    };
    await writeFile(join(home.aireg, "config.yml"), configs.gone);
    const installed = await aireg(["install", "--yes"]);
    expect(installed.code, installed.stderr).toBe(0);
    expect(installed.stderr).toContain(
      'Left "tracker" as it is: no loaded adapter declares its kind, "mcp_server".',
    );
    expect(installed.stderr).not.toContain("installed into no target");
    expect(await readFile(lockPath(project), "utf8")).toBe(lock);
    expect(linked()).toEqual([true, true, true]);

    const status = await aireg(["status"]);
    expect(status.code, status.stderr).toBe(0);
    expect(status.stderr).toContain(
      'warning: Did not check "review": no loaded adapter declares its kind, "prompt".',
    );
    expect(status.stdout).toContain("Everything else matches the lockfile.");

    await writeFile(join(home.aireg, "config.yml"), configs.bare);
    for (const command of [
      ["update", "--yes"],
      ["sync", "--yes"],
    ]) {
      const ran = await aireg(command);
      expect(ran.code, `${command[0]}: ${ran.stderr}`).toBe(0);
      expect(ran.stderr).toContain('Left "review" as it is: no loaded adapter declares its kind');
      expect(await readFile(lockPath(project), "utf8")).toBe(lock);
      expect(linked()).toEqual([true, true, true]);
    }

    await writeFile(join(home.aireg, "config.yml"), configs.back);
    const again = await aireg(["install", "--yes"]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("Already up to date.");
    expect(await readFile(lockPath(project), "utf8")).toBe(lock);
  });
});

describe("a declared MCP server kind", () => {
  test("is placed for Claude Code and Codex, and registered and unregistered in Codex's config", async ({
    aireg,
    project,
    kinds: remote,
  }) => {
    await seed(remote, "eng/mcp_server/tickets", SERVER("tickets"));
    await seed(remote, "eng/mcp_server/docs", SERVER("docs"));
    await writeManifestIn(project, REGISTRY);
    const config = join(project, ".codex", "config.toml");
    await write(config, '[mcp_servers.mine]\ncommand = "mine"\n');

    const add = (name: string) =>
      aireg([
        "add",
        `hosted/eng/mcp_server/${name}`,
        "--for",
        "claude-code",
        "--for",
        "codex",
        "--yes",
      ]);
    for (const name of ["tickets", "docs"]) {
      const added = await add(name);
      expect(added.code, added.stderr).toBe(0);
      for (const root of [".claude", ".codex"]) {
        expect(existsSync(join(project, root, "mcp", name, "server.json")), `${root} ${name}`).toBe(
          true,
        );
      }
    }
    const both = await readFile(config, "utf8");
    expect(both).toContain('[mcp_servers.mine]\ncommand = "mine"');
    for (const name of ["tickets", "docs"]) {
      const script = join(project, ".codex", "mcp", name, "server.js");
      expect(both).toContain(`[mcp_servers.${name}]\ncommand = ${JSON.stringify(script)}`);
    }

    const removed = await aireg(["remove", "tickets", "--yes"]);
    expect(removed.code, removed.stderr).toBe(0);
    const after = await readFile(config, "utf8");
    expect(after).not.toContain("tickets");
    expect(after).toContain('[mcp_servers.mine]\ncommand = "mine"');
    expect(after).toContain("[mcp_servers.docs]");
    expect(existsSync(join(project, ".claude", "mcp", "tickets"))).toBe(false);
    expect(existsSync(join(project, ".claude", "mcp", "docs", "server.json"))).toBe(true);
  });

  test("never takes over or deletes a server entry someone else wrote", async ({
    aireg,
    project,
    kinds: remote,
  }) => {
    await seed(remote, "eng/mcp_server/mine", SERVER("mine"));
    await writeManifestIn(project, REGISTRY);
    const config = join(project, ".codex", "config.toml");
    const own = '[mcp_servers.mine]\ncommand = "mine"\nargs = ["--x"]\n';
    await write(config, own);

    const added = await aireg(["add", "hosted/eng/mcp_server/mine", "--for", "codex", "--yes"]);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toContain(
      "warning: Left .codex/config.toml as it is for mine: mcp_servers.mine there is someone else's.",
    );
    expect(await readFile(config, "utf8")).toBe(own);
    const removed = await aireg(["remove", "mine", "--yes"]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(await readFile(config, "utf8")).toBe(own);
    expect(existsSync(join(project, ".codex", "mcp", "mine"))).toBe(false);
  });

  test("stays at its own place beside a namespace installed as a plugin", async ({
    aireg,
    home,
    kinds: remote,
    tmp,
  }) => {
    await seed(remote, "eng/skill/deploy", {
      "SKILL.md": "---\nname: deploy\ndescription: Ships.\n---\nrun\n",
    });
    await seed(remote, "eng/mcp_server/tickets", SERVER("tickets"));
    await mkdir(join(home.dir, ".claude"), { recursive: true });
    await mkdir(join(home.dir, ".codex"), { recursive: true });
    const added = await aireg(
      [
        "add",
        "-g",
        "https://kinds.registry.localhost",
        "--adapter",
        "kinds",
        "--for",
        "claude-code",
        "--for",
        "codex",
        "--no-auto-update",
        "--yes",
      ],
      { cwd: tmp },
    );
    expect(added.code, added.stderr).toBe(0);

    const plugin = join(home.dir, ".claude", "skills", "eng");
    expect(existsSync(join(plugin, "skills", "deploy", "SKILL.md"))).toBe(true);
    expect(existsSync(join(plugin, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(home.dir, ".claude", "mcp", "tickets", "server.json"))).toBe(true);
    // Its copy is kept apart from the namespace folder the plugin is assembled from.
    expect(readdirSync(plugin).sort()).toEqual([".claude-plugin", ".codex-plugin", "skills"]);
    const lock = parse(await readFile(join(home.dir, ".registry", "manifest.lock.yml"), "utf8"));
    // Its own row, linked at its own place: never a member of the namespace's plugin.
    expect(lock.artifacts["eng/tickets"].links.map((link: { path: string }) => link.path)).toEqual([
      ".claude/mcp/tickets",
      ".codex/mcp/tickets",
    ]);

    const cache = join(home.dir, ".codex", "plugins", "cache", "kinds", "eng", "local");
    expect(existsSync(join(cache, "skills", "deploy", "SKILL.md"))).toBe(true);
    expect(existsSync(join(cache, "mcp_servers"))).toBe(false);
    expect(existsSync(join(home.dir, ".codex", "mcp", "tickets", "server.json"))).toBe(true);
    const codex = await readFile(join(home.dir, ".codex", "config.toml"), "utf8");
    expect(codex).toContain('[plugins."eng@kinds"]');
    expect(codex).toContain("[mcp_servers.tickets]");
  });
  test("is refused when its folder is one a plugin loads, so its copy never lands in a plugin", async ({
    aireg,
    home,
    kinds: remote,
    tmp,
  }) => {
    const command = `{ name: "cmd", dir: "commands", shape: "file", extensions: [".md"], targets: { "claude-code": { shape: "file", subdir: "cmds", extension: ".md" } } }`;
    const adapter = await variant(
      home.dir,
      "commands.mjs",
      `artifactKinds: [...base.artifactKinds, "cmd"], extend: { kinds: [${command}] }`,
    );
    await writeFile(join(home.aireg, "config.yml"), config({ kinds: adapter }));
    await seed(remote, "eng/skill/deploy", {
      "SKILL.md": "---\nname: deploy\ndescription: Ships.\n---\nrun\n",
    });
    await seed(remote, "eng/cmd/ship", { "ship.md": "Ship it.\n" });
    await mkdir(join(home.dir, ".claude"), { recursive: true });
    await mkdir(join(home.dir, ".codex"), { recursive: true });
    const added = await aireg(
      [
        "add",
        "-g",
        "https://kinds.registry.localhost",
        "--adapter",
        "kinds",
        "--for",
        "claude-code",
        "--for",
        "codex",
        "--no-auto-update",
        "--yes",
      ],
      { cwd: tmp },
    );
    expect(added.code, added.stderr).toBe(0);
    expect(added.stderr).toContain(
      'The adapter "kinds" declares kinds aireg cannot use, so it adds none: "cmd" keeps its artifacts in "commands", a folder plugins load.',
    );
    const plugin = join(home.dir, ".claude", "skills", "eng");
    expect(existsSync(join(plugin, "skills", "deploy", "SKILL.md"))).toBe(true);
    expect(existsSync(join(plugin, "commands"))).toBe(false);
    const cache = join(home.dir, ".codex", "plugins", "cache", "kinds", "eng", "local");
    expect(existsSync(join(cache, "skills", "deploy", "SKILL.md"))).toBe(true);
    expect(existsSync(join(cache, "commands"))).toBe(false);
  });
});
