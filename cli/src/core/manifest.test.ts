import { mkdir, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, vi } from "vitest";
import { roots } from "#core/store/paths.ts";
import { test } from "#test/kit/fixtures.ts";
import { formatManifest, parseManifest, readManifest, writeManifest } from "./manifest.ts";
import { parseRef } from "./ref.ts";

// A release's version, so a manifest can ask for one older or newer than this CLI.
vi.mock("#core/version.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#core/version.ts")>()),
  VERSION: "0.5.0",
}));

describe("manifest keys", () => {
  test("reads `harnesses:` as the selection and `registries:` as the sources", () => {
    const manifest = parseManifest(
      [
        "harnesses: [claude, codex]",
        "registries:",
        "  kit: acme/kit",
        "artifacts:",
        "  - ref: kit/lint",
        "    harnesses: [claude]",
        "",
      ].join("\n"),
    );
    expect(manifest.targets).toEqual(["claude", "codex"]);
    expect(Object.keys(manifest.registries)).toEqual(["kit"]);
    expect(manifest.artifacts[0]?.targets).toEqual(["claude"]);
  });

  test("keeps `copy: true` on an entry, and writes it back", () => {
    const manifest = parseManifest(
      "registries: { kit: acme/kit }\nartifacts:\n  - { ref: kit/lint, copy: true }\n",
    );
    expect(manifest.artifacts[0]?.copy).toBe(true);
    expect(formatManifest(manifest)).toContain("copy: true");
    expect(() =>
      parseManifest(
        "registries: { kit: acme/kit }\nartifacts:\n  - { ref: kit/lint, copy: yes please }\n",
      ),
    ).toThrow('manifest.yml: `copy` of artifact "kit/lint" must be true or false.');
  });
});

describe("exports and publish", () => {
  const declared = [
    "registries:",
    "  acme: github.com/acme/agent-registry",
    "  public: github.com/acme/public-registry",
    "artifacts:",
    "  - public/platform/skill/sql-style@0.1.2",
    "",
  ].join("\n");
  const read = (rest: string) => parseManifest(`${declared}${rest}`);
  const refused = (rest: string) => () => read(rest);
  const entry = (lines: string) => `exports:\n  - path: .claude/agents/reviewer.md\n${lines}`;

  const full = [
    "exports:",
    "  - .claude/skills/*",
    "  - path: .claude/agents/reviewer.md",
    "    version: 2.0.0",
    "    depends_on:",
    "      - ./.claude/skills/review",
    "      - public/platform/skill/sql-style",
    "  - path: .claude/skills/scratch",
    "    publish: false",
    "publish:",
    "  to: acme/engineering",
    "",
  ].join("\n");

  test("reads a plain path or glob, and a mapping that refines one path the glob matches", () => {
    const manifest = read(full);
    expect(manifest.exports).toEqual([
      { path: ".claude/skills/*", version: undefined, dependsOn: [], publish: undefined },
      {
        path: ".claude/agents/reviewer.md",
        version: "2.0.0",
        dependsOn: [
          { type: "local", path: ".claude/skills/review" },
          { type: "remote", ref: parseRef("public/platform/skill/sql-style") },
        ],
        publish: undefined,
      },
      { path: ".claude/skills/scratch", version: undefined, dependsOn: [], publish: false },
    ]);
    expect(manifest.publish).toEqual({ to: "acme/engineering" });
  });

  test("refuses entries that are not paths or `{ path, ... }` mappings", () => {
    expect(refused("exports: skills/*\n")).toThrow("`exports:` must be a list of paths.");
    expect(refused("exports: [3]\n")).toThrow(
      "`exports:` entries must be paths or `{ path, ... }` mappings.",
    );
    expect(refused('exports: [""]\n')).toThrow("An `exports:` entry has an empty path.");
    expect(refused("exports:\n  - version: 1.0.0\n")).toThrow("An `exports:` entry has no `path`.");
    expect(refused(entry("    as: review\n"))).toThrow(
      'An `exports:` entry does not take "as"; it takes depends_on, exclude, ignore, include, kind, path, publish and version.',
    );
  });

  test("reads what an entry reaches and which files each artifact publishes, and writes it back", () => {
    const text = [
      "exports:",
      "  - path: agents",
      "    kind: agent",
      "    exclude:",
      "      - drafts",
      "    ignore:",
      "      - workspace-data/",
      '      - "*.log"',
      "  - path: agents/helper",
      "    include:",
      "      - workspace/AGENTS.md",
      "      - from: workspace/SOUL.md",
      "        as: identity/SOUL.md",
      "",
    ].join("\n");
    const manifest = read(text);
    expect(manifest.exports).toEqual([
      {
        path: "agents",
        kind: "agent",
        version: undefined,
        dependsOn: [],
        publish: undefined,
        exclude: ["drafts"],
        ignore: ["workspace-data/", "*.log"],
      },
      {
        path: "agents/helper",
        version: undefined,
        dependsOn: [],
        publish: undefined,
        include: [
          { from: "workspace/AGENTS.md", as: "workspace/AGENTS.md" },
          { from: "workspace/SOUL.md", as: "identity/SOUL.md" },
        ],
      },
    ]);
    expect(formatManifest(manifest)).toBe(`${declared}${text}`);
  });

  test("refuses a `kind` it does not export", () => {
    expect(refused(entry("    kind: plugin\n"))).toThrow(
      'manifest.yml: `kind` of export ".claude/agents/reviewer.md" must be skill or agent.',
    );
  });

  test("refuses an `exclude` name that is not directly inside the folder", () => {
    expect(refused(entry("    exclude: [a/b]\n"))).toThrow(
      'Export ".claude/agents/reviewer.md" excludes "a/b", which is not the name of something directly inside it.',
    );
    expect(refused(entry("    exclude: ['*']\n"))).toThrow("which is not the name of");
    expect(refused(entry("    exclude: [a, a]\n"))).toThrow(
      'Export ".claude/agents/reviewer.md" lists "a" twice under `exclude`.',
    );
    expect(refused(entry("    ignore: [3]\n"))).toThrow(
      '`ignore` of export ".claude/agents/reviewer.md" must be a list of gitignore patterns.',
    );
  });

  test("refuses an `include` path outside the artifact, a glob, or two files stored as one", () => {
    expect(refused(entry("    include: [../other.md]\n"))).toThrow(
      '`include` "../other.md" of export ".claude/agents/reviewer.md" leaves the artifact.',
    );
    expect(refused(entry("    include: ['docs/*']\n"))).toThrow(
      '`include` "docs/*" of export ".claude/agents/reviewer.md" is a glob, not a file or folder.',
    );
    expect(refused(entry("    include: [{ from: a.md, as: /b.md }]\n"))).toThrow(
      '`include as` "/b.md" of export ".claude/agents/reviewer.md" is absolute.',
    );
    expect(refused(entry("    include: [{ from: a.md }]\n"))).toThrow(
      'An `include` mapping of export ".claude/agents/reviewer.md" needs both `from` and `as`.',
    );
    expect(refused(entry("    include: [a.md, { from: b.md, as: a.md }]\n"))).toThrow(
      'Export ".claude/agents/reviewer.md" would store two files as a.md.',
    );
    expect(refused(entry("    include: [a.md, a.md]\n"))).toThrow(
      'Export ".claude/agents/reviewer.md" lists a.md twice under `include`.',
    );
  });

  test("refuses an `include` that would store a file as an entry file, or move one", () => {
    expect(refused(entry("    include: [{ from: notes.md, as: AGENT.md }]\n"))).toThrow(
      'Export ".claude/agents/reviewer.md" would store notes.md as AGENT.md, which is an entry file.',
    );
    expect(refused(entry("    include: [{ from: SKILL.md, as: docs/SKILL.md }]\n"))).toThrow(
      'Export ".claude/agents/reviewer.md" would store its entry file SKILL.md as docs/SKILL.md.',
    );
    // Listed as itself, it is what goes anyway.
    expect(read(entry("    include: [SKILL.md]\n")).exports[0]?.include).toEqual([
      { from: "SKILL.md", as: "SKILL.md" },
    ]);
  });

  test("refuses a path that is not below the project, written with /", () => {
    expect(refused("exports: [/etc/skills]\n")).toThrow('Export "/etc/skills" is absolute.');
    expect(refused("exports: ['C:/skills']\n")).toThrow('Export "C:/skills" is absolute.');
    expect(refused("exports: [skills/../../etc]\n")).toThrow(
      'Export "skills/../../etc" leaves the project.',
    );
    for (const glob of ["'{..,skills}/*'", "'skills/{x,..}/*'", "'{..}/*'"]) {
      expect(refused(`exports: [${glob}]\n`)).toThrow("leaves the project.");
    }
    expect(parseManifest("exports: ['skills/{a..b,c}']\n").exports).toHaveLength(1);
    expect(refused("exports: [./skills/lint]\n")).toThrow(
      'Export "./skills/lint" has an empty or . part.',
    );
    expect(refused("exports: [skills//lint]\n")).toThrow("has an empty or . part.");
    expect(refused("exports: ['skills\\\\lint']\n")).toThrow(
      "uses a backslash, where a path uses /.",
    );
    expect(refused("exports: [/etc/skills]\n")).toThrow(
      expect.objectContaining({
        hint: "Write it relative to the project, such as .claude/skills/review.",
      }),
    );
  });

  test("refuses a glob in a mapping, whose fields would apply to every path it matches", () => {
    expect(refused("exports:\n  - path: skills/*\n    publish: false\n")).toThrow(
      'Export "skills/*" is a glob, which only a plain `exports:` entry can be.',
    );
  });

  test("refuses the same path twice, but not a mapping beside a glob that matches it", () => {
    expect(refused("exports:\n  - path: skills/lint\n  - path: skills/lint\n")).toThrow(
      'Export "skills/lint" is listed more than once.',
    );
    expect(
      refused("exports:\n  - skills/lint\n  - path: skills/lint\n    version: 1.0.0\n"),
    ).toThrow("is listed more than once.");
    expect(
      read("exports:\n  - skills/*\n  - path: skills/lint\n    version: 1.0.0\n").exports,
    ).toHaveLength(2);
  });

  test("takes an exact version only", () => {
    const message =
      '`version` of export ".claude/agents/reviewer.md" must be an exact version, such as 2.0.0.';
    expect(refused(entry("    version: '2.0'\n"))).toThrow(message);
    expect(refused(entry("    version: 2.0\n"))).toThrow(message);
    expect(refused(entry("    version: ^2.0.0\n"))).toThrow(message);
    expect(refused(entry("    version: 2.0.0+build.1\n"))).toThrow(message);
    expect(read(entry("    version: 2.0.0-rc.1\n")).exports[0]?.version).toBe("2.0.0-rc.1");
  });

  test("reads `depends_on` as a list of paths and addresses, each once", () => {
    expect(refused(entry("    depends_on: ./skills/review\n"))).toThrow(
      '`depends_on` of export ".claude/agents/reviewer.md" must be a list of paths and addresses.',
    );
    expect(refused(entry("    depends_on: [3]\n"))).toThrow(
      "must be a list of paths and addresses.",
    );
    expect(refused(entry("    depends_on: [./skills/review, ./skills/review]\n"))).toThrow(
      'Export ".claude/agents/reviewer.md" lists "./skills/review" twice under `depends_on`.',
    );
  });

  test("reads `./` as a path in the project, checking only how it is written", () => {
    const of = 'Export ".claude/agents/reviewer.md" depends on';
    expect(
      read(entry("    depends_on: [./skills/not-yet-on-disk, ./skills]\n")).exports[0]?.dependsOn,
    ).toEqual([
      { type: "local", path: "skills/not-yet-on-disk" },
      { type: "local", path: "skills" },
    ]);
    expect(refused(entry("    depends_on: [./../skills/review]\n"))).toThrow(
      `${of} "./../skills/review", whose path leaves the project.`,
    );
    expect(refused(entry("    depends_on: [./skills/*]\n"))).toThrow(
      `${of} "./skills/*", a glob rather than a path.`,
    );
    expect(refused(entry("    depends_on: [./.claude/agents/reviewer.md]\n"))).toThrow(
      'Export ".claude/agents/reviewer.md" depends on itself.',
    );
  });

  test("reads anything else as an `artifacts:` entry's full address, with no version", () => {
    const of = 'Export ".claude/agents/reviewer.md" depends on';
    const neither = "which is neither ./<path> nor <registry>/<namespace>/<kind>/<name>.";
    expect(refused(entry("    depends_on: [skills/review]\n"))).toThrow(
      `${of} "skills/review", ${neither}`,
    );
    expect(refused(entry("    depends_on: [public/skill/sql-style]\n"))).toThrow(neither);
    expect(refused(entry("    depends_on: [public/platform/sql-style]\n"))).toThrow(neither);
    expect(refused(entry("    depends_on: [../skills/review]\n"))).toThrow(neither);
    expect(refused(entry("    depends_on: [public/platform/skill/sql-style@0.1.2]\n"))).toThrow(
      expect.objectContaining({
        message: `manifest.yml: ${of} "public/platform/skill/sql-style@0.1.2", but its version belongs on its \`artifacts:\` entry.`,
        hint: "Write public/platform/skill/sql-style here, and public/platform/skill/sql-style@0.1.2 under `artifacts:`.",
      }),
    );
    expect(refused(entry("    depends_on: [public/platform/skill/lint]\n"))).toThrow(
      expect.objectContaining({
        message: `manifest.yml: ${of} "public/platform/skill/lint", which is not listed under \`artifacts:\`.`,
        hint: "List it under `artifacts:`, such as `- public/platform/skill/lint`.",
      }),
    );
    // A whole namespace installs it too, but has no one entry to say which versions.
    expect(() =>
      parseManifest(
        "registries: { public: x }\nartifacts: [public/platform]\nexports:\n  - path: a.md\n    depends_on: [public/platform/skill/sql-style]\n",
      ),
    ).toThrow("which is not listed under `artifacts:`.");
  });

  test("reads an entry's `publish` as false alone", () => {
    const where = '`publish` of export ".claude/agents/reviewer.md"';
    for (const value of ["true", "{ to: acme/engineering }", "[acme/engineering]"]) {
      expect(
        refused(`${entry(`    publish: ${value}\n`)}publish:\n  to: acme/engineering\n`),
      ).toThrow(
        expect.objectContaining({
          message: `manifest.yml: ${where} takes only false.`,
          hint: "Remove it to publish the export to `publish.to`, or write `publish: false` to keep it here.",
        }),
      );
    }
    expect(read(entry("    publish: false\n")).exports[0]?.publish).toBe(false);
  });

  test("reads the top-level `publish.to` as one target in a declared registry or a folder", () => {
    expect(refused("publish: [acme/engineering]\n")).toThrow(
      "`publish:` must be a mapping with `to`.",
    );
    expect(refused("publish: {}\n")).toThrow("`publish:` has no `to`.");
    expect(refused("publish: { to: acme/engineering, from: x }\n")).toThrow(
      '`publish:` does not take "from"; it takes to.',
    );
    expect(refused("publish: { to: '' }\n")).toThrow(
      "`publish.to` must be one target, such as acme/engineering or ./registry/engineering.",
    );
    // A list was only ever unreleased, so it is refused with the one entry to write instead.
    expect(refused("publish: { to: [acme/engineering] }\n")).toThrow(
      expect.objectContaining({
        message: "manifest.yml: `publish.to` names one target, not a list.",
        hint: "Write it as `to: acme/engineering`.",
      }),
    );
    expect(refused("publish: { to: [acme/engineering, ./registry/eng] }\n")).toThrow(
      expect.objectContaining({
        hint: "Keep the one this project publishes to, such as `to: acme/engineering`.",
      }),
    );
    expect(refused("publish: { to: kit/eng }\n")).toThrow(
      expect.objectContaining({
        message:
          'manifest.yml: `publish.to` names registry "kit", which is not declared under `registries:`.',
        hint: "Declare it with `aireg registry add <address> --as kit`.",
      }),
    );
    for (const to of ["acme", "acme/eng/skill", "/eng/", "~/registry/eng"]) {
      expect(refused(`publish: { to: '${to}' }\n`)).toThrow(`\`publish.to\` names "${to}"`);
    }
    expect(refused("publish: { to: acme/Eng }\n")).toThrow(
      '`publish.to` names "acme/Eng", whose namespace is not valid.',
    );
    expect(refused("publish: { to: ./registry/Eng }\n")).toThrow(
      '`publish.to` names "./registry/Eng", a folder that does not end in a namespace.',
    );
    expect(refused("publish: { to: .eng }\n")).toThrow(
      "a folder that does not end in a namespace.",
    );
    for (const to of ["../registry/eng", "/srv/registry/eng", "./eng"]) {
      expect(read(`publish: { to: ${to} }\n`).publish).toEqual({ to });
    }
  });
});

describe("a registry's layout", () => {
  test("is a key of its own, beside `ref`, and reads under `config:` too", () => {
    const own = parseManifest("registries:\n  kit: { source: ../kit, layout: folder }\n");
    expect(own.registries.kit?.config).toEqual({ layout: "folder" });
    expect(formatManifest(own)).toContain("  kit:\n    source: ../kit\n    layout: folder\n");
    const nested = parseManifest(
      "registries:\n  kit: { source: ../kit, config: { layout: folder } }\n",
    );
    expect(formatManifest(nested)).toBe(formatManifest(own));
  });

  test("is refused when aireg reads no such layout", () => {
    expect(() => parseManifest("registries:\n  kit: { source: ../kit, layout: zip }\n")).toThrow(
      'manifest.yml: Registry "kit" has layout "zip", which is not registry',
    );
  });
});

describe("engines", () => {
  test("reads `engines.aireg` and writes it back", () => {
    const manifest = parseManifest("engines:\n  aireg: 0.3.0\n");
    expect(manifest.engine).toBe("0.3.0");
    expect(formatManifest(manifest)).toContain("engines:\n  aireg: 0.3.0\n");
  });

  test("says a newer aireg is needed, not that a key it added is unknown", () => {
    const newer = (rest: string) => () => parseManifest(`engines:\n  aireg: 99.0.0\n${rest}`);
    const needed = "This project needs aireg 99.0.0 or later; this CLI is 0.5.0.";
    expect(newer("overrides: {}\n")).toThrow(needed);
    expect(
      newer("registries: { kit: acme/kit }\nartifacts:\n  - { ref: kit/lint, pin: 1 }\n"),
    ).toThrow(needed);
    expect(newer("overrides: {}\n")).toThrow(
      expect.objectContaining({ code: "error", hint: "Run `aireg self update`." }),
    );
  });

  test("still names the unknown key when this aireg is new enough, or no version is asked for", () => {
    const unknown = 'manifest.yml: The manifest does not take "overrides"';
    expect(() => parseManifest("engines:\n  aireg: 0.3.0\noverrides: {}\n")).toThrow(unknown);
    expect(() => parseManifest("overrides: {}\n")).toThrow(unknown);
  });

  test("leaves a file it can read to the commands, which refuse to write for an older aireg", () => {
    expect(parseManifest("engines:\n  aireg: 99.0.0\n").engine).toBe("99.0.0");
  });
});

describe("writeManifest", () => {
  let project: ReturnType<typeof roots>;
  let path: string;
  test.beforeEach(async ({ tmp }) => {
    project = roots("project", tmp);
    path = project.manifest;
  });
  test("creates the scope folder and reads back what it wrote", async () => {
    const manifest = parseManifest("harnesses: [claude]\nregistries:\n  kit: acme/kit\n");
    await writeManifest(project, manifest);
    expect(await readManifest(path)).toEqual(manifest);
    expect(await readFile(path, "utf8")).toContain("registries:\n  kit: acme/kit\n");
  });

  const commented = [
    "# Agent artifacts for this project.",
    "",
    "# AI coding tools to install into.",
    "harnesses:",
    "  - claude # we only use claude",
    "",
    "# Each registry is one source.",
    "registries: {}",
    "  # acme:",
    "  #   source: github.com/acme/agent-kit",
    "",
    "# `acme` for all of it.",
    "artifacts: []",
    "",
  ].join("\n");
  const comments = (text: string) => text.split("\n").filter((line) => line.includes("#"));

  test("keeps the comments in the file through registry add, add and remove", async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, commented);

    const declared = await readManifest(path);
    declared.registries.acme = { location: "../acme", adapter: undefined, config: {} };
    await writeManifest(project, declared);
    const added = await readManifest(path);
    added.artifacts.push(parseRef("acme/engineering"), parseRef("acme/skill/lint@1.0.0"));
    await writeManifest(project, added);
    const removed = await readManifest(path);
    removed.artifacts = removed.artifacts.filter((ref) => ref.namespace !== "engineering");
    await writeManifest(project, removed);

    const text = await readFile(path, "utf8");
    expect(comments(text)).toEqual(comments(commented));
    expect(text).toContain("registries:\n  acme: ../acme\n  # acme:\n");
    expect(text).toContain("\n\n# `acme` for all of it.\nartifacts:\n  - acme/skill/lint@1.0.0\n");
    expect(await readManifest(path)).toEqual(removed);
  });

  test("keeps `exports:` and `publish:`, with their comments, through add and remove", async () => {
    const before = [
      "registries:",
      "  kit: acme/kit",
      "artifacts:",
      "  - kit/eng/skill/lint",
      "  - kit/eng/skill/sql-style@0.1.2",
      "",
      "# What this repository publishes.",
      "exports:",
      "  - skills/* # every skill",
      "  - path: agents/reviewer.md",
      "    depends_on:",
      "      - ./skills/review",
      "      - kit/eng/skill/sql-style",
      "",
      "# Where it goes.",
      "publish:",
      "  to: kit/eng",
      "",
    ].join("\n");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, before);

    const added = await readManifest(path);
    added.artifacts.push(parseRef("kit/eng/skill/format"));
    await writeManifest(project, added);
    const removed = await readManifest(path);
    removed.artifacts = removed.artifacts.filter((ref) => ref.name !== "lint");
    await writeManifest(project, removed);

    expect(await readFile(path, "utf8")).toBe(
      before
        .replace("  - kit/eng/skill/lint\n", "")
        .replace("@0.1.2\n", "@0.1.2\n  - kit/eng/skill/format\n"),
    );
    expect((await readManifest(path)).exports).toEqual(added.exports);
  });

  test("refuses to remove an artifact an export depends on, and leaves the file as it was", async () => {
    const before = [
      "registries:",
      "  kit: acme/kit",
      "artifacts:",
      "  - kit/eng/skill/sql-style",
      "exports:",
      "  - path: agents/reviewer.md",
      "    depends_on: [kit/eng/skill/sql-style]",
      "",
    ].join("\n");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, before);
    const manifest = await readManifest(path);
    manifest.artifacts = [];
    await expect(writeManifest(project, manifest)).rejects.toThrow(
      'depends on "kit/eng/skill/sql-style", which is not listed under `artifacts:`.',
    );
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("keeps an entry's own comment when its version changes", async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      "harnesses: [claude, codex]\nregistries:\n  kit: acme/kit\nartifacts:\n  - kit/skill/lint@1.0.0 # held back\n",
    );
    const manifest = await readManifest(path);
    manifest.artifacts = [parseRef("kit/skill/lint@1.1.0")];
    await writeManifest(project, manifest);

    expect(await readFile(path, "utf8")).toBe(
      "harnesses: [claude, codex]\nregistries:\n  kit: acme/kit\nartifacts:\n  - kit/skill/lint@1.1.0 # held back\n",
    );
  });

  // A command reads the manifest before it takes the lease, so it must never see one half written.
  test("replaces the file instead of truncating it, and leaves nothing beside it", async () => {
    await writeManifest(project, parseManifest("harnesses: [claude]\n"));
    const first = (await stat(path)).ino;
    await writeManifest(project, parseManifest("harnesses: [codex]\n"));
    expect((await stat(path)).ino).not.toBe(first);
    expect(await readdir(dirname(path))).toEqual(["manifest.yml"]);
  });

  test("refuses to write a manifest it could not read back, and leaves the file as it was", async () => {
    const before = "registries:\n  acme: ../acme\nartifacts:\n  - acme/eng/skill/lint\n";
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, before);
    const manifest = await readManifest(path);
    manifest.artifacts.push(parseRef("pr-review"));
    await expect(writeManifest(project, manifest)).rejects.toThrow(
      'Artifact "pr-review" names registry "pr-review", which is not declared',
    );
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("refuses a project's .registry that links out of the project", async ({ tmp }) => {
    const elsewhere = join(await realpath(tmp), "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, dirname(path));
    await expect(writeManifest(project, parseManifest("harnesses: [claude]\n"))).rejects.toThrow(
      "is a symlink in a managed path",
    );
    expect(await readdir(elsewhere)).toEqual([]);
  });
});

describe("names that reach a prototype", () => {
  test("are refused as registry names", () => {
    expect(() => parseManifest("registries:\n  __proto__: /evil\n")).toThrow(
      /cannot name a registry/,
    );
    expect(() => parseManifest("registries:\n  constructor: /evil\n")).toThrow(
      /cannot name a registry/,
    );
  });
});

describe("an address", () => {
  test("longer than any registry needs is refused before anything parses it", () => {
    const long = `https://example.com/${"a/".repeat(1100)}`;
    expect(() => parseManifest(`registries:\n  acme: ${long}\n`)).toThrow(/too long/);
    expect(() => parseManifest(`registries:\n  acme:\n    source: ${long}\n`)).toThrow(/too long/);
  });
});
