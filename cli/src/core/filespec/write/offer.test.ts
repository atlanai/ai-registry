import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, vi } from "vitest";
import type { PublishRelationship } from "#adapter/index.ts";
import { contentDigest, sha256 } from "#adapter/spec/canonical.ts";
import { buildEnvelope, describeFile } from "#adapter/spec/envelope.ts";
import { test } from "#test/kit/fixtures.ts";
import { offerFrom } from "./offer.ts";

const reads = vi.hoisted(() => ({ active: 0, peak: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      reads.active += 1;
      reads.peak = Math.max(reads.peak, reads.active);
      try {
        await new Promise((settle) => setTimeout(settle, 1));
        return await actual.readFile(...args);
      } finally {
        reads.active -= 1;
      }
    },
  };
});

let root: string;

test.beforeEach(async ({ tmp }) => {
  root = tmp;
  reads.peak = 0;
});

describe("offerFrom", () => {
  const edge = { rel_type: "depends_on", to: "eng/skill/style@1.2.0" };

  async function lint(): Promise<string> {
    const skill = join(root, "lint");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: lint\ndescription: Lints.\n---\n");
    return skill;
  }

  test("covers the relationships in the content id, and leaves it as it was without any", async () => {
    const skill = await lint();
    const target = { name: "lint", kind: "skill" as const, version: "1.0.0" };
    const bare = await offerFrom(skill, target);
    const none = await offerFrom(skill, { ...target, relationships: [] });
    const linked = await offerFrom(skill, { ...target, relationships: [edge] });

    // The digest an artifact without edges has always had, so nothing published moves.
    expect(bare.input.contentId).toBe(
      contentDigest(
        buildEnvelope({
          kind: "skill",
          metadata: { name: "lint", description: "Lints." },
          files: bare.input.files.map((file) =>
            describeFile(file.path, sha256(file.content), file.content.byteLength),
          ),
          spec: bare.input.spec,
        }),
      ),
    );
    expect(none.input.contentId).toBe(bare.input.contentId);
    expect(none.input).not.toHaveProperty("relationships");
    expect(linked.input.contentId).not.toBe(bare.input.contentId);
    expect(linked.input.relationships).toEqual([edge]);
    expect(linked.digests).toEqual(bare.digests);
  });

  test("sends only the files named, never reading or refusing one left out", async () => {
    const skill = await lint();
    await writeFile(join(skill, "notes.md"), "Scratch.\n");
    await writeFile(join(skill, ".env"), "TOKEN=x\n");
    const target = { name: "lint", kind: "skill" as const, version: "1.0.0" };
    const sent = await offerFrom(skill, {
      ...target,
      files: [{ from: "SKILL.md", as: "SKILL.md" }],
    });
    expect(sent.input.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    // Every file, when none are named, refusing the one that may hold credentials.
    await expect(offerFrom(skill, target)).rejects.toThrow("lint/.env may hold credentials");
  });

  test("sends a folder agent's AGENT.md first, then its other files", async () => {
    const agent = join(root, "helper");
    await mkdir(agent, { recursive: true });
    await writeFile(
      join(agent, "AGENT.md"),
      "---\nname: helper\ndescription: Helps.\n---\nHelp.\n",
    );
    await writeFile(join(agent, "a.md"), "First by name.\n");
    const { input } = await offerFrom(agent, { name: "helper", kind: "agent", version: "1.0.0" });
    expect(input.files.map((file) => file.path)).toEqual(["AGENT.md", "a.md"]);
    expect(input.spec).toMatchObject({ name: "helper", description: "Helps." });
  });

  test("sends only the fields an edge has in the spec", async () => {
    const skill = await lint();
    const extra = { ...edge, note: "kept out" } as typeof edge;
    const { input } = await offerFrom(skill, {
      name: "lint",
      kind: "skill",
      version: "1.0.0",
      relationships: [extra],
    });
    expect(input.relationships).toEqual([edge]);
  });

  test("refuses an edge the relationship schema does not allow, before reading a file", async () => {
    const target = { name: "lint", kind: "skill" as const, version: "1.0.0" };
    const refused = (relationships: PublishRelationship[]) =>
      offerFrom(join(root, "absent"), { ...target, relationships });
    await expect(refused([{ ...edge, rel_type: "Depends-On" }])).rejects.toThrow(
      'lint has a relationship of type "Depends-On", which is not lowercase letters, digits and underscores.',
    );
    await expect(refused([{ rel_type: "depends_on", to: "style@1.2.0" }])).rejects.toThrow(
      'lint has a depends_on edge to "style@1.2.0", which is not a namespace/kind/name@version.',
    );
  });
  test("reads a large tree a bounded number of files at a time", async () => {
    const skill = join(root, "lint");
    await mkdir(join(skill, "assets"), { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: lint\ndescription: Lints.\n---\n");
    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        writeFile(join(skill, "assets", `${index}.txt`), `asset ${index}`),
      ),
    );

    const { input } = await offerFrom(skill, { name: "lint", kind: "skill", version: "1.0.0" });
    expect(input.files).toHaveLength(301);
    // Unbounded, all 301 reads would be in flight together; macOS allows 256 descriptors.
    expect(reads.peak).toBeLessThanOrEqual(16);
  });
});

test("an agent card publish uses the target slug and preserves the card", async () => {
  const card = JSON.stringify({ name: "Recipe Agent", description: "Recipes.", skills: [] });
  await writeFile(join(root, "agent-card.json"), card);
  await writeFile(join(root, "README.md"), "Documentation.");
  const { input } = await offerFrom(root, {
    kind: "agent",
    name: "recipe-helper",
    version: "1.0.0",
  });
  expect(input.spec).toEqual({
    name: "recipe-helper",
    description: "Recipes.",
    card: JSON.parse(card),
  });
  expect(
    Buffer.from(input.files.find((file) => file.path === "agent-card.json")!.content).toString(),
  ).toBe(card);
});

test("publishing an explicit native agent file preserves its front matter", async () => {
  const path = join(root, "reviewer.md");
  const body = "---\nname: reviewer\ndescription: Reviews.\nmodel: sonnet\n---\nReview.\n";
  await writeFile(path, body);
  const { input } = await offerFrom(path, { kind: "agent", name: "reviewer", version: "1.0.0" });
  expect(input.spec).toEqual({ name: "reviewer", description: "Reviews.", model: "sonnet" });
  expect(input.files[0]?.path).toBe("reviewer.md");
  expect(Buffer.from(input.files[0]!.content).toString()).toBe(body);
});
