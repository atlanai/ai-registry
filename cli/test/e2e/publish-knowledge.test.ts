import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test as base } from "#test/kit/fixtures.ts";
import { writeManifestIn } from "#test/kit/scope.ts";

/** A hosted registry that takes knowledge bundles, writing down every input it is sent. */
async function recordingAdapter(home: string, id: string, publishKinds: string[]): Promise<string> {
  const adapter = join(home, `${id}.mjs`);
  const sent = join(home, `${id}.jsonl`);
  await mkdir(join(home, ".aireg"), { recursive: true, mode: 0o700 });
  await writeFile(
    adapter,
    [
      "import { appendFileSync } from 'node:fs';",
      "import { createHash } from 'node:crypto';",
      "export default {",
      `  id: '${id}',`,
      `  displayName: '${id}', protocol: 1, artifactKinds: ['skill', 'agent', 'knowledge'],`,
      `  publishKinds: ${JSON.stringify(publishKinds)},`,
      `  dispatch: { hosts: ['${id}.example'] },`,
      "  capabilities: { publish: true },",
      "  connect: async () => ({",
      "    resolve: async () => ({ artifacts: [] }),",
      "    fetch: async () => new Uint8Array(),",
      "    publish: async (inputs) => {",
      "      for (const { name, kind, namespace, version, spec, contentId, files } of inputs) {",
      "        const sent = files.map((file) => ({ path: file.path, sha256: createHash('sha256').update(file.content).digest('hex') }));",
      `        appendFileSync(${JSON.stringify(sent)}, JSON.stringify({ name, kind, namespace, version, spec, contentId: contentId.slice(0, 7), files: sent }) + '\\n');`,
      "      }",
      "      return {};",
      "    },",
      "    close: async () => {},",
      "  }),",
      "};",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(home, ".aireg", "config.yml"),
    `schemaVersion: 1\nrevision: 0\nadapters:\n  ${id}: ${adapter}\naccounts: []\njobs: []\n`,
  );
  return sent;
}

const ROUTING = '{\n  "routes": ["bdr", "ae"]\n}\n';
const CONCEPT = "---\ntype: Contract\ntitle: routing.json\n---\nWho owns the next touch.\n";
const QUERY = "-- For this set of account ids, what is the current deal state?\nselect 1;\n";

const test = base.extend("bundle", async ({ project }) => {
  const root = join(project, "knowledge", "accounts-and-signals");
  await mkdir(join(root, "contracts"), { recursive: true });
  await mkdir(join(root, "sql", "ddl"), { recursive: true });
  await writeFile(join(root, "contracts", "routing.json"), ROUTING);
  await writeFile(join(root, "contracts", "routing.json.md"), CONCEPT);
  await writeFile(join(root, "sql", "deal_state.sql"), QUERY);
  await writeFile(join(root, "index.md"), "# Accounts and signals\n");
  await writeFile(join(root, ".DS_Store"), "Finder.\n");
  return root;
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const manifest = (adapter: string) => `registries:
  hosted:
    source: https://${adapter}.example
    adapter: ${adapter}
exports:
  - path: knowledge/accounts-and-signals
    kind: knowledge
publish:
  to: hosted/revenue-os
`;

describe("publishing a knowledge bundle", () => {
  test("previews it as kind knowledge, then sends every file as written", async ({
    aireg,
    home: { dir: home },
    project,
    bundle: _,
  }) => {
    const sent = await recordingAdapter(home, "knowing", ["skill", "knowledge"]);
    await writeManifestIn(project, manifest("knowing"));

    const preview = await aireg(["publish", "--dry-run", "--json"]);
    expect(preview.code, preview.stderr).toBe(0);
    const { data: shown } = JSON.parse(preview.stdout);
    expect(shown.dryRun).toBe(true);
    expect(shown.artifacts).toEqual([
      expect.objectContaining({
        name: "accounts-and-signals",
        kind: "knowledge",
        namespace: "revenue-os",
        version: "0.1.0",
        published: false,
      }),
    ]);
    expect(existsSync(sent)).toBe(false);

    const published = await aireg(["publish", "--yes", "--json"]);
    expect(published.code, published.stderr).toBe(0);
    const lines = (await readFile(sent, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        name: "accounts-and-signals",
        kind: "knowledge",
        namespace: "revenue-os",
        version: "0.1.0",
        spec: { name: "accounts-and-signals" },
        contentId: "sha256:",
        files: [
          { path: "contracts/routing.json", sha256: sha(ROUTING) },
          { path: "contracts/routing.json.md", sha256: sha(CONCEPT) },
          { path: "index.md", sha256: sha("# Accounts and signals\n") },
          { path: "sql/deal_state.sql", sha256: sha(QUERY) },
        ],
      },
    ]);
  });

  test("refuses a bundle a registry would refuse, naming each path, and sends nothing", async ({
    aireg,
    home: { dir: home },
    project,
    bundle,
  }) => {
    const sent = await recordingAdapter(home, "knowing", ["knowledge"]);
    await writeManifestIn(project, manifest("knowing"));
    await writeFile(join(bundle, "notes.md"), "No front matter here.\n");
    await writeFile(join(bundle, "bundle.zip"), "PK");

    const preview = await aireg(["publish", "--dry-run"]);
    expect(preview.code).toBe(1);
    expect(preview.stderr).toContain(
      "revenue-os/knowledge/accounts-and-signals is not an Open Knowledge Format bundle: bundle.zip is reserved for the bundle's own download; notes.md has no `---` delimited YAML front matter (Open Knowledge Format v0.2 §4.1).",
    );
    expect(existsSync(sent)).toBe(false);
  });

  test("skips it for a registry that does not take knowledge bundles", async ({
    aireg,
    home: { dir: home },
    project,
    bundle: _,
  }) => {
    await recordingAdapter(home, "skilled", ["skill"]);
    await writeManifestIn(project, manifest("skilled"));
    const shown = await aireg(["publish", "--yes", "--json"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout).data.skipped).toEqual([
      {
        name: "accounts-and-signals",
        kind: "knowledge",
        path: "knowledge/accounts-and-signals",
        reason: "hosted does not take knowledge bundles",
      },
    ]);
  });

  test("refuses to install one", async ({ aireg, home: { dir: home }, project }) => {
    await recordingAdapter(home, "knowing", ["knowledge"]);
    await writeManifestIn(
      project,
      "registries:\n  hosted:\n    source: https://knowing.example\n    adapter: knowing\n",
    );
    const added = await aireg(["add", "hosted/revenue-os/knowledge/accounts-and-signals"]);
    expect(added.code).toBe(2);
    expect(added.stderr).toContain(
      "hosted/revenue-os/knowledge/accounts-and-signals is a knowledge bundle, which aireg publishes but does not install.",
    );
  });
});
