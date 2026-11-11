import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { isRecord } from "#adapter/fields.ts";
import { test } from "#test/kit/fixtures.ts";
import {
  entryName,
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
  const glossary = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "kinds/glossary.json",
    title: "glossary",
    type: "object",
    properties: {
      name: { type: "string", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 64 },
      description: { type: "string", minLength: 1, maxLength: 1024 },
      terms: { type: "object" },
    },
    required: ["name", "terms"],
    additionalProperties: false,
    "x-registry-schema-version": 1,
    "x-registry-files": {
      required: [{ path: "glossary.yaml", media_type: "application/yaml" }],
      optional: [{ glob: "source/**" }],
    },
  } as KindManifest;
  const kinds = { glossary };
  const document = "name: Flights\ndescription: Flight terms by route.\nterms:\n  - name: leg\n";
  const parsed = {
    name: "Flights",
    description: "Flight terms by route.",
    terms: [{ name: "leg" }],
  };

  test("wraps the document under the key its manifest declares, as an agent's card is", () => {
    const files = new Map([["glossary.yaml", text(document)]]);
    const spec = envelopeSpec("glossary", files, kinds, "flights");
    expect(spec).toEqual({ name: "flights", description: "Flight terms by route.", terms: parsed });
    expect(check(glossary, spec)).toEqual([]);
  });

  test("names it by the document's own name, made a slug, when no folder names it", () => {
    const files = new Map([["glossary.yaml", text(document)]]);
    expect(envelopeSpec("glossary", files, kinds).name).toBe("flights");
  });

  test("reads the file the manifest names, not a YAML file kept under source/", () => {
    const files = new Map([
      ["source/dbt_project.yml", text("name: jaffle_shop\n")],
      ["glossary.yaml", text(document)],
    ]);
    expect(envelopeSpec("glossary", files, kinds, "flights").terms).toEqual(parsed);
  });

  test("has no spec when the YAML does not parse", () => {
    const files = new Map([["glossary.yaml", text("name: [unclosed\n")]]);
    expect(envelopeSpec("glossary", files, kinds)).toEqual({});
  });

  test("stores a lone document under the file its manifest names", () => {
    expect(entryName(glossary, "flights.yml")).toBe("glossary.yaml");
    expect(entryName(glossary, "glossary.yaml")).toBe("glossary.yaml");
    expect(entryName(glossary, "flights.json")).toBe("flights.json");
    expect(entryName(glossary, "README.md")).toBe("README.md");
  });
});

describe("a semantic model", () => {
  const ossie = async (file: string): Promise<Uint8Array> =>
    new Uint8Array(await readFile(join(OSSIE, file)));
  const manifest = async (): Promise<KindManifest> =>
    (await kindsOf(undefined)).semantic_model as KindManifest;
  const specFrom = (source: Uint8Array, entry = "semantic_model.yaml") =>
    envelopeSpec("semantic_model", new Map([[entry, source]]), undefined, "retail");

  test("is a kind every registry holds, beside skill and agent", async () => {
    expect(Object.keys(await kindsOf(undefined))).toEqual(["skill", "agent", "semantic_model"]);
  });

  test.for([
    ["tpcds_semantic_model.yaml", "TPC-DS retail semantic model for sales and customer analytics"],
    ["flights.semantic_model.yaml", undefined],
    [
      "tpcds_semantic_model.v0.1.1.yaml",
      "TPC-DS retail semantic model for sales and customer analytics",
    ],
  ] as const)(
    "wraps Apache Ossie's own example %s and finds it valid",
    async ([file, description]) => {
      const spec = specFrom(await ossie(file));
      expect(spec.name).toBe("retail");
      expect(spec.description).toBe(description);
      expect(isRecord(spec.model)).toBe(true);
      expect(check(await manifest(), spec)).toEqual([]);
    },
  );

  test("keeps the model's own name in the document, under the registry's slug", async () => {
    const spec = specFrom(await ossie("tpcds_semantic_model.yaml"));
    expect((spec.model as { name: string }).name).toBe("tpcds_retail_model");
  });

  test("reads a model saved as JSON", async () => {
    const model = { version: "0.2.0.dev0", name: "Retail", datasets: [{ name: "s", source: "t" }] };
    const spec = specFrom(text(JSON.stringify(model)), "semantic_model.json");
    expect(spec).toEqual({ name: "retail", model });
    expect(check(await manifest(), spec)).toEqual([]);
  });

  test("reads its own file, not a document kept under source/", async () => {
    const files = new Map([
      ["source/semantic_models.yml", text("semantic_models:\n  - name: orders\n")],
      ["semantic_model.yaml", await ossie("flights.semantic_model.yaml")],
    ]);
    const spec = envelopeSpec("semantic_model", files, undefined, "flights");
    expect((spec.model as { version: string }).version).toBe("0.2.0.dev0");
  });

  test("refuses a file that is not a semantic model, with the fields that are wrong", async () => {
    const spec = specFrom(await ossie("invalid-flights-ontology.yaml"));
    expect(check(await manifest(), spec)).toEqual([
      "`model.datasets` is required",
      "`model.requires` is not a field this kind takes",
      "`model.ontology` is not a field this kind takes",
      "`model.ontology_mappings` is not a field this kind takes",
    ]);
  });

  test("refuses a model written to one version's shape that declares the other", async () => {
    const source = Buffer.from(await ossie("tpcds_semantic_model.v0.1.1.yaml"))
      .toString("utf8")
      .replace('version: "0.1.1"', 'version: "0.2.0.dev0"');
    const problems = check(await manifest(), specFrom(text(source)));
    expect(problems).toContain("`model.name` is required");
    expect(problems).toContain("`model.semantic_model` is not a field this kind takes");
  });

  test("refuses a version of Ossie it has no schema for, and a model that declares none", async () => {
    const dataset = { name: "s", source: "t" };
    const newer = { version: "0.3.0", name: "Retail", datasets: [dataset] };
    expect(
      check(await manifest(), specFrom(text(JSON.stringify(newer)), "semantic_model.json")),
    ).toEqual(["`model.version` must be equal to one of the allowed values"]);
    const none = { name: "Retail", datasets: [dataset] };
    expect(
      check(await manifest(), specFrom(text(JSON.stringify(none)), "semantic_model.json")),
    ).toEqual(["`model.version` is required"]);
  });

  test("stores a lone model under the kind's file name, whatever it was called", async () => {
    expect(entryName(await manifest(), "retail.yml")).toBe("semantic_model.yaml");
    expect(entryName(await manifest(), "retail.json")).toBe("semantic_model.json");
  });
});
