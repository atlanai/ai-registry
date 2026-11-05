import { describe, expect, test } from "vitest";
import type { ArtifactKind } from "#adapter/kinds.ts";
import { acquired, entry } from "#test/kit/builders/plan.ts";
import { closure, idOf, type Need } from "./depends.ts";
import type { Acquired, Selected } from "./model.ts";

/** `eng/<kind>/<name>` at each version given, with the edges each version declares. */
type Published = [kind: ArtifactKind, name: string, version: string, ...needs: string[]];

const path = (kind: ArtifactKind, name: string) => `artifacts/eng/${kind}/${name}`;

function need(ref: string): Need {
  const [address, version] = ref.split("@") as [string, string];
  const [namespace, kind, name] = address.split("/") as [string, ArtifactKind, string];
  return { namespace, kind, name, version };
}

/** One registry, `kit`, holding one version of each artifact. */
function registry(...published: Published[]): Acquired[] {
  const sources = acquired(
    published.map(([kind, name]) => entry({ name, kind, path: path(kind, name), group: "eng" })),
  );
  const [source] = sources as [Acquired];
  for (const [kind, name, version, ...needs] of published) {
    source.placements.set(path(kind, name), {
      id: path(kind, name),
      name,
      contentId: `sha256:${name}`,
      version,
      needs: needs.map(need),
    });
  }
  return sources;
}

/** What the manifest asks for: `named` unless it came with its whole namespace. */
function selected(
  kind: ArtifactKind,
  name: string,
  version: string,
  over: Partial<Selected> = {},
): Selected {
  return {
    name,
    kind,
    source: "kit",
    path: path(kind, name),
    id: path(kind, name),
    upstreamName: name,
    contentId: undefined,
    version,
    contents: [],
    group: "eng",
    named: true,
    ...over,
  };
}

const id = (kind: string, name: string) => idOf("kit", "eng", kind, name);
const refs = (result: ReturnType<typeof closure>) =>
  result.refs.map((ref) => `${ref.kind}/${ref.name}@${ref.version}`).sort();

describe("closure", () => {
  test("follows edges transitively, at the version each one names", () => {
    const result = closure(
      [selected("agent", "reviewer", "0.3.0")],
      registry(
        ["agent", "reviewer", "0.3.0", "eng/skill/pr-review@1.2.0"],
        ["skill", "pr-review", "1.2.0", "eng/skill/lint@1.0.0"],
        ["skill", "lint", "1.0.0"],
      ),
    );

    expect(refs(result)).toEqual(["skill/lint@1.0.0", "skill/pr-review@1.2.0"]);
    expect(result.neededBy.get(id("skill", "lint"))).toEqual(new Set([id("skill", "pr-review")]));
    expect(result.firstBy.get(id("skill", "pr-review"))).toBe("eng/agent/reviewer");
    expect(result.unresolved).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  test("reports a version the registry does not hold, and who needed it", () => {
    const result = closure(
      [selected("agent", "reviewer", "0.3.0")],
      registry(["agent", "reviewer", "0.3.0", "eng/skill/lint@9.9.9"], ["skill", "lint", "1.0.0"]),
    );

    expect(result.unresolved).toEqual([
      { alias: "kit", need: need("eng/skill/lint@9.9.9"), by: "eng/agent/reviewer" },
    ]);
  });

  test("refuses two dependents that need one artifact at two versions", () => {
    const result = closure(
      [selected("agent", "reviewer", "0.3.0"), selected("agent", "helper", "1.0.0")],
      registry(
        ["agent", "reviewer", "0.3.0", "eng/skill/lint@1.0.0"],
        ["agent", "helper", "1.0.0", "eng/skill/lint@2.0.0"],
        ["skill", "lint", "1.0.0"],
      ),
    );

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.message).toContain("eng/skill/lint is needed at two versions");
  });

  test("holds a version the manifest names against a dependent, but not one a namespace brought", () => {
    const published = registry(
      ["agent", "reviewer", "0.3.0", "eng/skill/lint@1.0.0"],
      ["skill", "lint", "1.0.0"],
    );
    const pinned = closure(
      [selected("agent", "reviewer", "0.3.0"), selected("skill", "lint", "2.0.0")],
      published,
    );
    expect(pinned.conflicts[0]?.message).toContain("but the manifest installs 2.0.0");

    const brought = closure(
      [
        selected("agent", "reviewer", "0.3.0"),
        selected("skill", "lint", "2.0.0", { named: false }),
      ],
      published,
    );
    expect(brought.conflicts).toEqual([]);
    expect(refs(brought)).toEqual(["skill/lint@1.0.0"]);
  });

  test("ends a cycle where it began", () => {
    const result = closure(
      [selected("skill", "ping", "1.0.0")],
      registry(
        ["skill", "ping", "1.0.0", "eng/skill/pong@1.0.0"],
        ["skill", "pong", "1.0.0", "eng/skill/ping@1.0.0"],
      ),
    );

    expect(refs(result)).toEqual(["skill/pong@1.0.0"]);
    expect(result.neededBy.get(id("skill", "ping"))).toEqual(new Set([id("skill", "pong")]));
  });

  test("puts a dependency in the targets its dependents were narrowed to", () => {
    const published = registry(
      ["agent", "reviewer", "0.3.0", "eng/skill/lint@1.0.0"],
      ["agent", "helper", "1.0.0", "eng/skill/lint@1.0.0"],
      ["skill", "lint", "1.0.0"],
    );
    const narrowed = closure(
      [
        selected("agent", "reviewer", "0.3.0", { targets: ["codex"] }),
        selected("agent", "helper", "1.0.0", { targets: ["claude-code"] }),
      ],
      published,
    );
    expect(narrowed.refs[0]?.targets).toEqual(["claude-code", "codex"]);

    // One dependent the scope's own targets reach, so the dependency goes there too.
    const scoped = closure(
      [
        selected("agent", "reviewer", "0.3.0", { targets: ["codex"] }),
        selected("agent", "helper", "1.0.0"),
      ],
      published,
    );
    expect(scoped.refs[0]?.targets).toBeUndefined();
  });
});
