import { describe, expect, it } from "vitest";
import type { SourceArtifact } from "#adapter/index.ts";
import { exportedNeeds } from "./exported.ts";

/** What a folder of skills holds, each listed with its path as its id. */
const HELD: SourceArtifact[] = [
  {
    path: ".claude/agents/reviewer.md",
    id: ".claude/agents/reviewer.md",
    kind: "agent",
    name: "reviewer",
    namespace: "tools",
  },
  {
    path: ".claude/agents/triage.md",
    id: ".claude/agents/triage.md",
    kind: "agent",
    name: "triage",
    namespace: "tools",
  },
  {
    path: ".claude/skills/review",
    id: ".claude/skills/review",
    kind: "skill",
    name: "review",
    namespace: "tools",
  },
];

const listed = HELD.map(({ id, name }) => ({ id, name }));

const read = (text: string) => exportedNeeds({ text, artifacts: HELD }, listed);

describe("exportedNeeds", () => {
  it("gives an export its sibling with no version, and a registry artifact with its range", () => {
    const { needs, warnings } = read(`registries:
  shared: https://github.com/acme/shared.git
artifacts:
  - shared/platform/skill/sql-style@^1.2
exports:
  - path: .claude/agents/reviewer.md
    depends_on:
      - ./.claude/skills/review/SKILL.md
      - shared/platform/skill/sql-style
`);
    expect(warnings).toEqual([]);
    expect(needs).toEqual(
      new Map([
        [
          ".claude/agents/reviewer.md",
          [
            { namespace: "tools", kind: "skill", name: "review" },
            {
              namespace: "platform",
              kind: "skill",
              name: "sql-style",
              range: "^1.2",
              registry: "https://github.com/acme/shared",
            },
          ],
        ],
      ]),
    );
  });

  it("combines what every entry naming one export gives it", () => {
    const { needs } = read(`registries:
  shared: https://github.com/acme/shared.git
artifacts:
  - shared/platform/skill/sql-style@^1.2
exports:
  - path: .claude/skills/review
    depends_on: [./.claude/agents/triage.md]
  - path: .claude/skills/review/SKILL.md
    depends_on: [shared/platform/skill/sql-style, ./.claude/agents/triage.md]
`);
    expect(needs.get(".claude/skills/review")).toEqual([
      { namespace: "tools", kind: "agent", name: "triage" },
      expect.objectContaining({ name: "sql-style", range: "^1.2" }),
    ]);
  });

  it("takes a pinned artifact at its version, and one with neither at any", () => {
    const { needs } = read(`registries:
  shared: github.com/acme/shared
artifacts:
  - shared/platform/skill/sql-style@1.2.0
  - shared/platform/skill/lint
exports:
  - path: .claude/agents/reviewer.md
    depends_on: [shared/platform/skill/sql-style, shared/platform/skill/lint]
`);
    expect(needs.get(".claude/agents/reviewer.md")).toEqual([
      expect.objectContaining({ name: "sql-style", version: "1.2.0" }),
      {
        namespace: "platform",
        kind: "skill",
        name: "lint",
        registry: "https://github.com/acme/shared",
      },
    ]);
  });

  it("gives a folder of the source as each artifact directly inside it", () => {
    const { needs, warnings } = read(`exports:
  - path: .claude/skills/review
    depends_on: [./.claude/agents, ./.claude/agents/triage.md]
  - path: .claude/agents/reviewer.md
    depends_on: [./.claude]
`);
    expect(needs.get(".claude/skills/review")).toEqual([
      { namespace: "tools", kind: "agent", name: "reviewer" },
      { namespace: "tools", kind: "agent", name: "triage" },
    ]);
    // An artifact in the folder does not depend on itself through it.
    expect(
      read("exports:\n  - path: .claude/agents/triage.md\n    depends_on: [./.claude/agents]\n")
        .needs,
    ).toEqual(
      new Map([
        [".claude/agents/triage.md", [{ namespace: "tools", kind: "agent", name: "reviewer" }]],
      ]),
    );
    // Nothing is directly inside .claude, so it gives no edge.
    expect(needs.has(".claude/agents/reviewer.md")).toBe(false);
    expect(warnings).toEqual([
      '"reviewer" depends on "./.claude", which this source does not hold; it was left out.',
    ]);
  });

  it("gives a path a glob exports nothing, and never matches a glob", () => {
    // Matched as a glob, this would backtrack for longer than any test waits.
    const slow = `${"*a".repeat(20)}b`;
    const { needs } = read(`exports:
  - .claude/agents/*.md
  - "${slow}"
  - path: .claude/agents/triage.md
    depends_on: [./.claude/skills/review]
`);
    expect([...needs.keys()]).toEqual([".claude/agents/triage.md"]);
  });

  it("leaves out, with a warning, an edge to what the source does not hold or a folder registry", () => {
    const { needs, warnings } = read(`registries:
  shared: ../shared
artifacts:
  - shared/platform/skill/sql-style
exports:
  - path: .claude/agents/reviewer.md
    depends_on: [./.claude/skills/gone, shared/platform/skill/sql-style]
`);
    expect(needs.size).toBe(0);
    expect(warnings).toEqual([
      '"reviewer" depends on "./.claude/skills/gone", which this source does not hold; it was left out.',
      '"reviewer" depends on "shared/platform/skill/sql-style", in a registry the source declares at "../shared", which has no https address; it was left out.',
    ]);
  });

  it("ignores a newer aireg's keys and engine, and only what the request listed gets edges", () => {
    const text = `engines:
  aireg: 99.0.0
overrides: {}
exports:
  - path: .claude/agents/reviewer.md
    depends_on: [./.claude/skills/review]
    signed: true
`;
    expect(read(text).needs.get(".claude/agents/reviewer.md")).toHaveLength(1);
    const only = exportedNeeds({ text, artifacts: HELD }, [
      { id: ".claude/skills/review", name: "review" },
    ]);
    expect(only.needs.size).toBe(0);
  });

  it("warns about a manifest that does not read, and gives nothing", () => {
    for (const text of ["exports: [\n", "- just a list\n", "exports:\n  - ../outside\n"]) {
      const { needs, warnings } = read(text);
      expect(needs.size).toBe(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(
        /^Ignored \.registry\/manifest\.yml, which aireg cannot read \(.+\), so what it exports installs without its dependencies\.$/,
      );
    }
  });
});
