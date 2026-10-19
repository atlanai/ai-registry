import { mkdir, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect } from "vitest";
import { roots } from "#core/store/paths.ts";
import { test } from "#test/kit/fixtures.ts";
import { formatManifest, parseManifest, readManifest, writeManifest } from "./manifest.ts";
import { parseRef } from "./ref.ts";

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
