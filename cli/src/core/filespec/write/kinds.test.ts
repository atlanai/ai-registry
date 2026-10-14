import { describe, expect, it } from "vitest";
import {
  check,
  envelopeSpec,
  fileProblems,
  type KindManifest,
  kindsOf,
  primaryFiles,
} from "./kinds.ts";

const text = (body: string) => new TextEncoder().encode(body);

describe("fileProblems", async () => {
  const { skill, agent } = (await kindsOf(undefined)) as Record<string, KindManifest>;

  it("names each required file a version lacks", () => {
    expect(fileProblems(skill as KindManifest, new Set(["SKILL.md"]))).toEqual([]);
    expect(fileProblems(skill as KindManifest, new Set(["notes.md"]))).toEqual(["has no SKILL.md"]);
  });

  it("asks for one whole set of a choice, naming them all when none is whole", () => {
    expect(fileProblems(agent as KindManifest, new Set(["AGENT.md"]))).toEqual([]);
    expect(fileProblems(agent as KindManifest, new Set(["agent-card.json"]))).toEqual([]);
    expect(fileProblems(agent as KindManifest, new Set(["notes.md"]))).toEqual([
      "has no AGENT.md or agent-card.json",
    ]);
  });
});

describe("envelopeSpec", () => {
  it("reads a kind's document from its front matter", () => {
    const files = new Map([
      ["SKILL.md", text("---\nname: lint\ndescription: Lint it.\n---\nRun the linter.\n")],
      ["scripts/run.sh", text("#!/bin/sh\n")],
    ]);
    expect(envelopeSpec("skill", files)).toEqual({ name: "lint", description: "Lint it." });
  });

  it("keeps an agent card whole and lifts the fields the kind requires beside it", () => {
    const card = { name: "triage", description: "Routes.", runtime: "any", skills: ["x"] };
    const spec = envelopeSpec("agent", new Map([["agent-card.json", text(JSON.stringify(card))]]));
    expect(spec).toEqual({ name: "triage", description: "Routes.", card });
  });

  it("is empty for a kind with no manifest, or files with no document", () => {
    expect(envelopeSpec("tool", new Map([["SKILL.md", text("---\nname: x\n---\n")]]))).toEqual({});
    expect(envelopeSpec("agent", new Map([["agent-card.json", text("{")]]))).toEqual({});
  });
});

describe("check", () => {
  it("names each field that breaks the schema", () => {
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

  it("keeps native agent fields and validates the shared fields", () => {
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

  it("uses only the declared built-in entry, regardless of file order", () => {
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

  it("rejects both agent entries and scaffolds shared files with the chosen alternative", () => {
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

  it("enforces skill constraints at their boundaries", () => {
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
