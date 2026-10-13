import { describe, expect, it } from "vitest";
import { check, envelopeSpec, type KindManifest, kindsOf, missingFiles } from "./kinds.ts";

const text = (body: string) => new TextEncoder().encode(body);

describe("missingFiles", async () => {
  const { skill, agent } = (await kindsOf(undefined)) as Record<string, KindManifest>;

  it("names each required file a version lacks", () => {
    expect(missingFiles(skill as KindManifest, new Set(["SKILL.md"]))).toEqual([]);
    expect(missingFiles(skill as KindManifest, new Set(["notes.md"]))).toEqual(["SKILL.md"]);
  });

  it("asks for one whole set of a choice, naming them all when none is whole", () => {
    expect(missingFiles(agent as KindManifest, new Set(["AGENT.md"]))).toEqual([]);
    expect(missingFiles(agent as KindManifest, new Set(["agent-card.json"]))).toEqual([]);
    expect(missingFiles(agent as KindManifest, new Set(["notes.md"]))).toEqual([
      "AGENT.md or agent-card.json",
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
