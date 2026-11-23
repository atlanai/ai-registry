import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test as base } from "#test/kit/fixtures.ts";
import { writeManifestIn } from "#test/kit/scope.ts";
import { skillBody } from "#test/kit/spec-root.ts";

// A source that records messages hears whether a person wrote the one it gets, so it can keep its
// own account of the change over the subject aireg composes from names and versions.
const test = base.extend("recording", async ({ home: { dir: home }, project }) => {
  const adapter = join(home, "messages.mjs");
  const sent = join(home, "sent.jsonl");
  await mkdir(join(home, ".aireg"), { recursive: true, mode: 0o700 });
  await writeFile(
    adapter,
    [
      "import { appendFileSync } from 'node:fs';",
      "export default {",
      "  id: 'messages',",
      "  displayName: 'Messages', protocol: 1, artifactKinds: ['skill'],",
      "  publishKinds: ['skill'],",
      "  dispatch: { hosts: ['messages.example'] },",
      "  capabilities: { publish: true, messages: true },",
      "  connect: async () => ({",
      "    resolve: async () => ({ artifacts: [] }),",
      "    fetch: async () => new Uint8Array(),",
      "    publish: async (inputs, { message, messageGiven }) => {",
      `      appendFileSync(${JSON.stringify(sent)}, JSON.stringify({ message, messageGiven }) + '\\n');`,
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
    `schemaVersion: 1\nrevision: 0\nadapters:\n  messages: ${adapter}\naccounts: []\njobs: []\n`,
  );
  await mkdir(join(project, ".claude", "skills", "review"), { recursive: true });
  await writeFile(
    join(project, ".claude", "skills", "review", "SKILL.md"),
    skillBody("review", "The review checklist."),
  );
  await writeManifestIn(
    project,
    `registries:
  hosted:
    source: https://messages.example
    adapter: messages
exports:
  - .claude/skills/review
publish:
  to: hosted/eng
`,
  );
  return sent;
});

async function sentOptions(sent: string): Promise<unknown[]> {
  const lines = (await readFile(sent, "utf8")).trim().split("\n");
  return lines.map((line) => JSON.parse(line));
}

describe("the message a publish hands its source", () => {
  test("is marked as given when it came from -m", async ({ aireg, recording: sent }) => {
    const published = await aireg(["publish", "--yes", "-m", "Tightens the checklist."]);
    expect(published.code, published.stderr).toBe(0);
    expect(await sentOptions(sent)).toEqual([
      { message: "Tightens the checklist.", messageGiven: true },
    ]);
  });

  test("is marked as composed when aireg wrote it", async ({ aireg, recording: sent }) => {
    const published = await aireg(["publish", "--yes"]);
    expect(published.code, published.stderr).toBe(0);
    expect(await sentOptions(sent)).toEqual([{ message: "add review 0.1.0", messageGiven: false }]);
  });
});
