import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import {
  envelopeSpec,
  fileProblems,
  type KindManifest,
  kindsOf,
  manifestProblems,
  primaryFiles,
} from "./kind-manifests.ts";
import { check } from "./schema.ts";

const text = (body: string) => new TextEncoder().encode(body);
const OSSIE = join(import.meta.dirname, "..", "..", "..", "test", "fixtures", "ossie");

describe("fileProblems", async () => {
  const { skill, agent } = (await kindsOf(undefined)) as Record<string, KindManifest>;

  test("names each required file a version lacks", () => {
    expect(fileProblems(skill as KindManifest, new Set(["SKILL.md"]))).toEqual([]);
    expect(fileProblems(skill as KindManifest, new Set(["notes.md"]))).toEqual(["has no SKILL.md"]);
  });

  test("asks for one whole set of a choice, naming them all when none is whole", () => {
    expect(fileProblems(agent as KindManifest, new Set(["AGENT.md"]))).toEqual([]);
    expect(fileProblems(agent as KindManifest, new Set(["agent-card.json"]))).toEqual([]);
    expect(fileProblems(agent as KindManifest, new Set(["notes.md"]))).toEqual([
      "has no AGENT.md or agent-card.json",
    ]);
  });
});

describe("envelopeSpec", () => {
  test("reads a kind's document from its front matter", () => {
    const files = new Map([
      ["SKILL.md", text("---\nname: lint\ndescription: Lint it.\n---\nRun the linter.\n")],
      ["scripts/run.sh", text("#!/bin/sh\n")],
    ]);
    expect(envelopeSpec("skill", files)).toEqual({ name: "lint", description: "Lint it." });
  });

  test("is empty for a kind with no manifest, or files with no document", () => {
    expect(envelopeSpec("tool", new Map([["SKILL.md", text("---\nname: x\n---\n")]]))).toEqual({});
    expect(envelopeSpec("agent", new Map([["agent-card.json", text("{")]]))).toEqual({});
  });
});

describe("check", () => {
  test("names each field that breaks the schema", () => {
    const schema = {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: { name: { type: "string", pattern: "^[a-z]+$", maxLength: 5 } },
    };
    expect(check(schema, { name: "lint" })).toEqual([]);
    expect(check(schema, { extra: 1 })).toEqual([
      "`name` is required",
      "`extra` is not a field this kind takes",
    ]);
    expect(check(schema, { name: "Linting" })).toEqual([
      "`name` is longer than 5 characters",
      '`name` "Linting" does not match ^[a-z]+$',
    ]);
    expect(check(schema, "x")).toEqual(["the front matter must be object"]);
    const short = { type: "string", minLength: 3 };
    expect(check(short, "ab")).toEqual(["the front matter is shorter than 3 characters"]);
    expect(check(short, "")).toEqual(["the front matter is empty"]);
  });
});

describe("native kind contracts", async () => {
  const manifests = await kindsOf(undefined);
  const skill = manifests.skill!;
  const agent = manifests.agent!;

  test("keeps native agent fields and validates the shared fields", () => {
    const files = new Map([
      [
        "AGENT.md",
        text(
          "---\nname: reviewer\ndescription: Reviews.\ntools: Read, Grep\nmodel: sonnet\ncustom:\n  enabled: true\n---\nReview.",
        ),
      ],
    ]);
    const spec = envelopeSpec("agent", files);
    expect(spec).toEqual({
      name: "reviewer",
      description: "Reviews.",
      tools: "Read, Grep",
      model: "sonnet",
      custom: { enabled: true },
    });
    expect(check(agent, spec)).toEqual([]);
    expect(check(agent, { ...spec, description: 7 })).not.toEqual([]);
    expect(check(agent, { ...spec, runtime: { model: "x" } })).toEqual([]);
  });

  test("uses only the declared built-in entry, regardless of file order", () => {
    const card = { name: "Recipe Agent", description: "Recipes.", skills: [] };
    const extras = [
      ["README.md", text("---\nname: wrong\ndescription: Wrong.\n---\n")],
      ["a.json", text('{"name":"wrong","description":"Wrong."}')],
      ["agent-card.json", text(JSON.stringify(card))],
    ] as const;
    for (const entries of [extras, [...extras].reverse()]) {
      expect(envelopeSpec("agent", new Map(entries), manifests, "recipe-helper")).toEqual({
        name: "recipe-helper",
        description: "Recipes.",
        card,
      });
      expect(envelopeSpec("agent", new Map(entries))).toEqual({
        name: "recipe-agent",
        description: "Recipes.",
        card,
      });
    }
    expect(envelopeSpec("skill", new Map(extras))).toEqual({});
    expect(envelopeSpec("agent", new Map(extras.slice(0, 2)))).toEqual({});
  });

  test("rejects both agent entries and scaffolds shared files with the chosen alternative", () => {
    expect(fileProblems(agent, new Set(["AGENT.md", "agent-card.json"]))).toEqual([
      "must contain exactly one file alternative: AGENT.md or agent-card.json",
    ]);
    const shared = {
      ...agent,
      "x-registry-files": { ...agent["x-registry-files"], required: [{ path: "LICENSE" }] },
    };
    expect(primaryFiles(shared, "agent-card.json")).toEqual(["LICENSE", "agent-card.json"]);
    expect(primaryFiles(shared)).toEqual(["LICENSE", "AGENT.md"]);
    expect(() => primaryFiles(shared, "README.md")).toThrow("not a file alternative");
    expect(() => primaryFiles(skill, "README.md")).toThrow("not a file alternative");
  });

  test("enforces skill constraints at their boundaries", () => {
    const spec = { name: "pdf-processing", description: "PDFs." };
    expect(check(skill, { ...spec, name: "pdf--processing" })).not.toEqual([]);
    expect(check(skill, { ...spec, name: "a".repeat(64) })).toEqual([]);
    expect(check(skill, { ...spec, name: "a".repeat(65) })).not.toEqual([]);
    expect(check(skill, { ...spec, compatibility: "" })).not.toEqual([]);
    expect(check(skill, { ...spec, compatibility: "x".repeat(500) })).toEqual([]);
    expect(check(skill, { ...spec, compatibility: "x".repeat(501) })).not.toEqual([]);
    expect(check(skill, { ...spec, description: "😀".repeat(1024) })).toEqual([]);
    expect(check(skill, { ...spec, description: "😀".repeat(1025) })).not.toEqual([]);
    expect(check(skill, { ...spec, custom: true })).not.toEqual([]);
  });
});

async function servingNote(root: string, kinds: unknown[], files: unknown): Promise<void> {
  await mkdir(join(root, "kinds"), { recursive: true });
  await writeFile(join(root, "registry.json"), JSON.stringify({ name: "team", kinds }));
  const manifest = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "kinds/note.json",
    title: "note",
    type: "object",
    "x-registry-schema-version": 1,
    "x-registry-files": files,
  };
  await writeFile(join(root, "kinds", "note.json"), JSON.stringify(manifest));
}

describe("a kind manifest a registry serves", () => {
  test("is refused when any alternative names a file outside the version", async ({ tmp }) => {
    const note = [{ name: "note", manifest_url: "kinds/note.json" }];
    await servingNote(tmp, note, { one_of: [[{ path: "NOTE.md" }], [{ path: "../x.md" }]] });
    expect(await kindsOf(tmp)).not.toHaveProperty("note");
    expect(await manifestProblems(tmp)).toEqual([
      {
        path: "kinds/note.json",
        message: expect.stringContaining(
          'names the file "../x.md", which is not a path inside a version',
        ),
      },
    ]);
  });

  test("is refused, with its command, when registry.json lists it under no kind name", async ({
    tmp,
  }) => {
    await servingNote(
      tmp,
      [{ name: "../note", manifest_url: "kinds/note.json" }, { name: "skill" }],
      {
        required: [{ path: "NOTE.md" }],
      },
    );
    expect(Object.keys(await kindsOf(tmp))).toEqual(["skill"]);
    expect(await manifestProblems(tmp)).toEqual([
      {
        path: "registry.json",
        message: 'lists "../note", which is not a kind name, so it is not used',
      },
    ]);
  });
});

describe("a custom kind whose entry is YAML", () => {
  // The shape a semantic_model kind holding an Apache Ossie document takes.
  const semanticModel = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "kinds/semantic_model.json",
    title: "semantic_model",
    type: "object",
    properties: {
      name: { type: "string", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 64 },
      description: { type: "string", minLength: 1, maxLength: 1024 },
      model: { type: "object" },
    },
    required: ["name", "model"],
    additionalProperties: false,
    "x-registry-schema-version": 1,
    "x-registry-files": {
      required: [{ path: "semantic_model.yaml", media_type: "application/vnd.ossie+yaml" }],
      optional: [{ glob: "source/**" }],
    },
  } as KindManifest;
  const kinds = { semantic_model: semanticModel };
  const model =
    "name: Flights\ndescription: Flight bookings by route.\ndatasets:\n  - name: flights\n";
  const parsed = {
    name: "Flights",
    description: "Flight bookings by route.",
    datasets: [{ name: "flights" }],
  };

  test("wraps the document under the key its manifest declares, as an agent's card is", () => {
    const files = new Map([["semantic_model.yaml", text(model)]]);
    const spec = envelopeSpec("semantic_model", files, kinds, "flights");
    expect(spec).toEqual({
      name: "flights",
      description: "Flight bookings by route.",
      model: parsed,
    });
    expect(check(semanticModel, spec)).toEqual([]);
  });

  test("names it by the document's own name, made a slug, when no folder names it", () => {
    const files = new Map([["semantic_model.yaml", text(model)]]);
    expect(envelopeSpec("semantic_model", files, kinds).name).toBe("flights");
  });

  test("reads the file the manifest names, not a YAML file kept under source/", () => {
    const files = new Map([
      ["source/dbt_project.yml", text("name: jaffle_shop\n")],
      ["semantic_model.yaml", text(model)],
    ]);
    expect(envelopeSpec("semantic_model", files, kinds, "flights").model).toEqual(parsed);
  });

  test.for([
    ["tpcds_semantic_model.yaml", "TPC-DS retail semantic model for sales and customer analytics"],
    ["flights.semantic_model.yaml", undefined],
  ] as const)("reads Apache Ossie's own example %s", async ([file, description]) => {
    const source = new Uint8Array(await readFile(join(OSSIE, file)));
    const spec = envelopeSpec(
      "semantic_model",
      new Map([["semantic_model.yaml", source]]),
      kinds,
      "retail",
    );
    expect(spec.name).toBe("retail");
    expect(spec.description).toBe(description);
    expect((spec.model as { datasets: unknown[] }).datasets.length).toBeGreaterThan(0);
    expect(check(semanticModel, spec)).toEqual([]);
  });

  test("has no spec when the YAML does not parse", () => {
    const files = new Map([["semantic_model.yaml", text("name: [unclosed\n")]]);
    expect(envelopeSpec("semantic_model", files, kinds)).toEqual({});
  });
});
