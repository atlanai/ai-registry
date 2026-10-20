import { describe, expect, it } from "vitest";
import { buildEnvelope } from "#adapter/index.ts";
import type { ArtifactKind } from "#core/kinds.ts";
import { emptyLock } from "#core/lock.ts";
import { lock } from "#test/kit/builders/lock.ts";
import { acquired, entry } from "#test/kit/builders/plan.ts";
import {
  closure,
  idOf,
  movesWithin,
  type Need,
  needsOf,
  registryUrls,
  unknownUrls,
  wantOf,
} from "./depends.ts";
import type { Acquired, Placement, Selected } from "./model.ts";

/** `eng/<kind>/<name>` at each version given, with the edges each version declares. */
type Published = [kind: ArtifactKind, name: string, version: string, ...needs: string[]];

const path = (kind: ArtifactKind, name: string) => `artifacts/eng/${kind}/${name}`;

/**
 * `eng/skill/lint@1.0.0`, or with a range after a space: `eng/skill/lint@1.0.0 ^1.0.0`. Without
 * an `@`, the edge names no version, as one export of a source does another.
 */
function need(ref: string): Need {
  const [to, ...range] = ref.split(" ");
  const [address, version] = (to as string).split("@") as [string, string | undefined];
  const [namespace, kind, name] = address.split("/") as [string, ArtifactKind, string];
  return {
    namespace,
    kind,
    name,
    ...(version === undefined ? {} : { version }),
    ...(range.length === 0 ? {} : { range: range.join(" ") }),
  };
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
  it("follows edges transitively, at the version each one names", () => {
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

  it("reports a version the registry does not hold, and who needed it", () => {
    const result = closure(
      [selected("agent", "reviewer", "0.3.0")],
      registry(["agent", "reviewer", "0.3.0", "eng/skill/lint@9.9.9"], ["skill", "lint", "1.0.0"]),
    );

    expect(result.unresolved).toEqual([
      { alias: "kit", need: need("eng/skill/lint@9.9.9"), by: "eng/agent/reviewer" },
    ]);
  });

  it("refuses two dependents that need one artifact at two versions", () => {
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

  it("holds a version the manifest names against a dependent, but not one a namespace brought", () => {
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

  it("ends a cycle where it began", () => {
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

  it("puts a dependency in the harnesses its dependents were narrowed to", () => {
    const published = registry(
      ["agent", "reviewer", "0.3.0", "eng/skill/lint@1.0.0"],
      ["agent", "helper", "1.0.0", "eng/skill/lint@1.0.0"],
      ["skill", "lint", "1.0.0"],
    );
    const narrowed = closure(
      [
        selected("agent", "reviewer", "0.3.0", { targets: ["codex"] }),
        selected("agent", "helper", "1.0.0", { targets: ["claude"] }),
      ],
      published,
    );
    expect(narrowed.refs[0]?.targets).toEqual(["claude", "codex"]);

    // One dependent the scope's own harnesses reach, so the dependency goes there too.
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

describe("closure, with ranges", () => {
  const review = (version: string, ...needs: string[]): Published => [
    "skill",
    "review",
    version,
    ...needs,
  ];
  const two = (...published: Published[]) =>
    closure(
      [selected("agent", "reviewer", "0.3.0"), selected("agent", "triage", "1.0.0")],
      registry(
        ["agent", "reviewer", "0.3.0", "eng/skill/review@0.3.2 ^0.3.2"],
        ["agent", "triage", "1.0.0", "eng/skill/review@0.3.4 ^0.3.4"],
        ...published,
      ),
    );

  it("takes the version a registry lists when every range accepts it", () => {
    const result = two(review("0.3.9"));
    expect(result.unresolved).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.neededBy.get(id("skill", "review"))).toEqual(
      new Set([id("agent", "reviewer"), id("agent", "triage")]),
    );
    expect(result.dependsOn.get(id("agent", "triage"))).toEqual(
      new Map([[id("skill", "review"), "^0.3.4"]]),
    );
  });

  it("asks again at the range every edge admits, naming each", () => {
    const result = two(review("0.3.3"));
    expect(result.conflicts).toEqual([]);
    expect(result.unresolved).toEqual([
      {
        alias: "kit",
        need: need("eng/skill/review@0.3.2 >=0.3.4 <0.4.0"),
        by: "eng/agent/reviewer",
        needed: [
          { at: "^0.3.2", by: "eng/agent/reviewer" },
          { at: "^0.3.4", by: "eng/agent/triage" },
        ],
      },
    ]);
  });

  it("asks for one range as the edge wrote it", () => {
    const result = closure(
      [selected("agent", "reviewer", "0.3.0")],
      registry(["agent", "reviewer", "0.3.0", "eng/skill/review@0.3.2 ^0.3.2"]),
    );
    expect(result.unresolved).toEqual([
      { alias: "kit", need: need("eng/skill/review@0.3.2 ^0.3.2"), by: "eng/agent/reviewer" },
    ]);
  });

  it("refuses ranges no version could satisfy together, naming every one and who set it", () => {
    const result = closure(
      [selected("agent", "reviewer", "0.3.0"), selected("agent", "triage", "1.0.0")],
      registry(
        ["agent", "reviewer", "0.3.0", "eng/skill/review@0.3.2 ^0.3.2"],
        ["agent", "triage", "1.0.0", "eng/skill/review@0.4.0 ^0.4.0"],
        review("0.3.9"),
      ),
    );
    expect(result.unresolved).toEqual([]);
    expect(result.conflicts).toEqual([
      {
        message:
          "eng/skill/review is needed at versions that do not overlap: ^0.3.2 by eng/agent/reviewer, and ^0.4.0 by eng/agent/triage.",
        hint: "Only one version can be installed here. Remove one of them, or ask the registry's owner to publish versions that agree.",
      },
    ]);
  });

  it("combines two long ranges that collapse, and refuses one too long to ask for", () => {
    const minors = (step: number) =>
      Array.from({ length: 12 }, (_, at) => `~10.${100 + at * step}`).join(" || ");
    const two = (left: string, right: string) =>
      closure(
        [selected("agent", "reviewer", "0.3.0"), selected("agent", "triage", "1.0.0")],
        registry(
          ["agent", "reviewer", "0.3.0", `eng/skill/review@10.100.0 ${left}`],
          ["agent", "triage", "1.0.0", `eng/skill/review@10.100.0 ${right}`],
          review("9.0.0"),
        ),
      );

    const collapsed = two(minors(1), minors(1).replaceAll("~", ""));
    expect(collapsed.conflicts).toEqual([]);
    expect(collapsed.unresolved.map((item) => item.need.range)).toEqual([">=10.100.0 <10.112.0"]);

    // With gaps between them, the twelve sets stay apart and make more than a registry reads.
    const apart = two(minors(2), ">=10.0.0");
    expect(apart.unresolved).toEqual([]);
    expect(apart.conflicts.map((conflict) => conflict.message)).toEqual([
      `eng/skill/review is needed at ${minors(2)} by eng/agent/reviewer, and >=10.0.0 by eng/agent/triage, which combine into a range longer than 256 characters.`,
    ]);
  });

  it("holds an edge without a range to its version, which every range must accept", () => {
    const exact = closure(
      [selected("agent", "reviewer", "0.3.0"), selected("agent", "triage", "1.0.0")],
      registry(
        ["agent", "reviewer", "0.3.0", "eng/skill/review@0.3.6 ^0.3.2"],
        ["agent", "triage", "1.0.0", "eng/skill/review@0.3.5"],
        review("0.3.9"),
      ),
    );
    expect(exact.unresolved.map((item) => item.need)).toEqual([need("eng/skill/review@0.3.5")]);

    const outside = closure(
      [selected("agent", "reviewer", "0.3.0"), selected("agent", "triage", "1.0.0")],
      registry(
        ["agent", "reviewer", "0.3.0", "eng/skill/review@0.3.6 ^0.3.6"],
        ["agent", "triage", "1.0.0", "eng/skill/review@0.3.5"],
        review("0.3.9"),
      ),
    );
    expect(outside.conflicts[0]?.message).toBe(
      "eng/skill/review is needed at versions that do not overlap: ^0.3.6 by eng/agent/reviewer, and 0.3.5 by eng/agent/triage.",
    );
  });

  it("holds a version the manifest names against a range, accepting one inside it", () => {
    const published = registry(["agent", "reviewer", "0.3.0", "eng/skill/review@0.3.2 ^0.3.2"]);
    const inside = closure(
      [selected("agent", "reviewer", "0.3.0"), selected("skill", "review", "0.3.7")],
      published,
    );
    expect(inside.conflicts).toEqual([]);
    expect(inside.refs).toEqual([]);
    expect(inside.neededBy.get(id("skill", "review"))).toEqual(new Set([id("agent", "reviewer")]));

    const outside = closure(
      [selected("agent", "reviewer", "0.3.0"), selected("skill", "review", "0.4.0")],
      published,
    );
    expect(outside.conflicts).toEqual([
      {
        message:
          "eng/agent/reviewer needs eng/skill/review ^0.3.2, but the manifest installs 0.4.0.",
        hint: "Only one version can be installed here. Pin the one it needs with `aireg add kit/eng/skill/review@0.3.2`, or remove one of them.",
      },
    ]);
  });

  it("drops what a dependency read at a version a later edge refuses raised, and asks again", () => {
    // reviewer reads lint at 1.2.0, whose own edges conflict with reviewer's, before triage's
    // edge, read through helper, says lint must be at least 1.5.0.
    const result = closure(
      [selected("agent", "reviewer", "0.3.0"), selected("agent", "triage", "1.0.0")],
      registry(
        ["agent", "reviewer", "0.3.0", "eng/skill/lint@1.0.0 ^1.0.0", "eng/skill/fmt@2.0.0"],
        ["agent", "triage", "1.0.0", "eng/skill/helper@1.0.0"],
        ["skill", "helper", "1.0.0", "eng/skill/lint@1.5.0 ^1.5.0"],
        ["skill", "lint", "1.2.0", "eng/skill/fmt@1.0.0", "eng/skill/gone@1.0.0"],
        ["skill", "fmt", "2.0.0"],
      ),
    );
    expect(result.conflicts).toEqual([]);
    expect(result.unresolved).toEqual([
      {
        alias: "kit",
        need: need("eng/skill/lint@1.0.0 >=1.5.0 <2.0.0"),
        by: "eng/agent/reviewer",
        needed: [
          { at: "^1.0.0", by: "eng/agent/reviewer" },
          { at: "^1.5.0", by: "eng/skill/helper" },
        ],
      },
    ]);
  });
});

describe("closure, across registries", () => {
  const PLATFORM = "https://github.com/acme/agent-registry";
  const style = { ...need("eng/skill/style@1.2.0 ^1.2.0"), registry: PLATFORM };

  /** `kit`, whose reviewer needs `style` from the registry at PLATFORM, and that registry. */
  function sources(alias: string, ...versions: string[]): Acquired[] {
    const [kit] = registry(["agent", "reviewer", "0.3.0"]) as [Acquired];
    (kit.placements.get(path("agent", "reviewer")) as Placement).needs = [style];
    const [other] = registry(...versions.map((v): Published => ["skill", "style", v])) as [
      Acquired,
    ];
    return [kit, { ...other, alias }];
  }
  const top = [selected("agent", "reviewer", "0.3.0")];
  const declared = new Map([
    ["kit", undefined],
    ["platform", PLATFORM],
  ]);

  it("resolves in the registry declared at the edge's URL, under that registry's name", () => {
    const result = closure(top, sources("platform", "1.3.0"), declared);

    expect(result.refs).toEqual([
      {
        registry: "platform",
        namespace: "eng",
        kind: "skill",
        name: "style",
        version: "1.2.0",
        range: "^1.2.0",
      },
    ]);
    expect(result.neededBy.get(idOf("platform", "eng", "skill", "style"))).toEqual(
      new Set([id("agent", "reviewer")]),
    );
    expect(result.unresolved).toEqual([]);
    expect(result.undeclared).toEqual([]);
  });

  it("asks that registry again when it lists no version the edge accepts", () => {
    const result = closure(top, sources("platform", "2.0.0"), declared);

    expect(result.unresolved).toEqual([
      { alias: "platform", need: style, by: "eng/agent/reviewer" },
    ]);
  });

  it("reports a URL no declared registry is at, and takes nothing for it", () => {
    const result = closure(top, sources("platform", "1.3.0"), new Map([["platform", undefined]]));

    expect(result.refs).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.undeclared).toEqual([{ url: PLATFORM, need: style, by: "eng/agent/reviewer" }]);
  });

  it("resolves in its dependent's own registry when the edge names that one's URL", () => {
    const [kit] = sources("platform");
    (kit as Acquired).catalog.entries.push(
      entry({ name: "style", kind: "skill", path: path("skill", "style"), group: "eng" }),
    );
    (kit as Acquired).placements.set(path("skill", "style"), {
      id: path("skill", "style"),
      name: "style",
      contentId: undefined,
      version: "1.2.5",
    });
    const result = closure(top, [kit as Acquired], new Map([["kit", PLATFORM]]));

    expect(refs(result)).toEqual(["skill/style@1.2.0"]);
    expect(result.refs[0]?.registry).toBe("kit");
  });

  it("refuses a URL more than one declared registry is at, naming them", () => {
    const [kit, platform] = sources("platform", "1.3.0") as [Acquired, Acquired];
    const urls = new Map([
      ["aaa", PLATFORM],
      ["kit", undefined],
      ["platform", PLATFORM],
    ]);
    const result = closure(top, [kit, platform, { ...platform, alias: "aaa" }], urls);

    expect(result.refs).toEqual([]);
    expect(result.conflicts).toEqual([
      {
        message: `eng/agent/reviewer needs eng/skill/style from ${PLATFORM}, and 2 declared registries are at that URL: "aaa" and "platform".`,
        hint: "Keep one of them, and remove the others with `aireg registry remove <name>`.",
      },
    ]);
  });

  it("waits on a registry whose URL is unknown before choosing where an edge resolves", () => {
    // Read, `disk` could report the same URL, which would make the edge ambiguous.
    const result = closure(top, sources("platform", "1.3.0"), declared, ["disk"]);

    expect(result.refs).toEqual([]);
    expect(result.undeclared).toEqual([{ url: PLATFORM, need: style, by: "eng/agent/reviewer" }]);
  });

  it("does not resolve in a registry that only claims the edge's URL", () => {
    // A registry declared at an https address is known by it, whatever its registry.json says.
    const [kit, platform] = sources("platform", "1.3.0") as [Acquired, Acquired];
    const evil = { ...platform, alias: "aaa" };
    evil.origin = { ...platform.origin, url: PLATFORM };
    const manifest = {
      aaa: { location: "https://github.com/evil/aaa", adapter: undefined, config: {} },
      kit: { location: "./kit", adapter: undefined, config: {} },
    };
    const result = closure(top, [kit, evil], registryUrls(manifest, [kit, evil]));

    expect(result.refs).toEqual([]);
    expect(result.undeclared).toEqual([{ url: PLATFORM, need: style, by: "eng/agent/reviewer" }]);
  });

  it("follows the registry a lockfile row recorded for a dependency", () => {
    const [kit, platform] = sources("platform", "1.3.0") as [Acquired, Acquired];
    const recorded = { ...need("eng/skill/style@1.3.0"), alias: "platform" };
    (kit.placements.get(path("agent", "reviewer")) as Placement).needs = [recorded];
    const result = closure(top, [kit, platform]);

    expect(result.refs.map((ref) => ref.registry)).toEqual(["platform"]);
    expect(result.undeclared).toEqual([]);
  });
});

describe("registryUrls", () => {
  const declared = (location: string) => ({ location, adapter: undefined, config: {} });

  it("knows a registry by its declared address, and a folder by the https URL it reported", () => {
    const [read] = registry() as [Acquired];
    read.origin.url = "https://example.com/mirror-of";
    const urls = registryUrls(
      {
        kit: declared("./kit"),
        hub: declared("https://github.com/acme/hub.git"),
        disk: declared("./disk"),
      },
      [read],
    );

    expect([...urls]).toEqual([
      ["disk", undefined],
      ["hub", "https://github.com/acme/hub"],
      ["kit", "https://example.com/mirror-of"],
    ]);
  });

  it("never lets what a registry with an https address reports stand for another one", () => {
    // `evil` claims shared's URL in its own registry.json; only what the person declared counts.
    const [evil] = registry() as [Acquired];
    const claimed = { ...evil, alias: "evil" };
    claimed.origin = { ...evil.origin, url: "https://github.com/acme/shared" };
    const urls = registryUrls({ evil: declared("https://github.com/evil/registry") }, [claimed]);

    expect([...urls]).toEqual([["evil", "https://github.com/evil/registry"]]);
  });

  it("takes a folder's URL from the lockfile when the folder was not read", () => {
    const recorded = lock()
      .registry("disk", { location: "./disk", url: "https://github.com/acme/disk" })
      .registry("moved", { location: "./old", url: "https://github.com/acme/moved" })
      .build();
    const urls = registryUrls({ disk: declared("./disk"), moved: declared("./new") }, [], recorded);

    // Recorded for another address, the URL says nothing about what is declared now.
    expect([...urls]).toEqual([
      ["disk", "https://github.com/acme/disk"],
      ["moved", undefined],
    ]);
  });

  it("says which registries only reading them can tell the URL of", () => {
    const [read] = registry() as [Acquired];
    const recorded = lock()
      .registry("disk", { location: "./disk", url: "https://github.com/acme/disk" })
      .build();
    const unknown = unknownUrls(
      {
        disk: declared("./disk"),
        hub: declared("https://github.com/acme/hub"),
        kit: declared("./kit"),
        other: declared("./other"),
      },
      [read],
      recorded,
    );

    expect(unknown).toEqual(["other"]);
  });
});

describe("needsOf", () => {
  const edges = (...relationships: { to: string; range?: unknown }[]) =>
    needsOf(
      buildEnvelope({
        kind: "agent",
        metadata: { name: "reviewer" },
        files: [{ path: "AGENT.md", digest: `sha256:${"0".repeat(64)}`, size: 1 }],
        relationships: relationships.map((edge) => ({ rel_type: "depends_on", ...edge }) as never),
      }),
    );

  it("reads the registry an edge names as one URL, and leaves out one that is not https", () => {
    expect(
      edges(
        { to: "eng/skill/lint@1.2.0", registry: "https://GitHub.com/acme/kit.git" } as never,
        { to: "eng/skill/fmt@1.0.0", registry: "http://github.com/acme/kit" } as never,
        { to: "eng/skill/sort@1.0.0", registry: 7 } as never,
      ),
    ).toEqual({
      needs: [{ ...need("eng/skill/lint@1.2.0"), registry: "https://github.com/acme/kit" }],
      unusable: [
        { to: "eng/skill/fmt@1.0.0", registry: "http://github.com/acme/kit" },
        { to: "eng/skill/sort@1.0.0", registry: "7" },
      ],
    });
  });

  it("reads a range its own version satisfies, and leaves out one it does not", () => {
    expect(
      edges(
        { to: "eng/skill/lint@1.2.0", range: "^1.2.0" },
        { to: "eng/skill/fmt@1.0.0", range: "^2.0.0" },
        { to: "eng/skill/sort@1.0.0", range: ">= 1" },
        { to: "eng/skill/tidy@1.0.0", range: 3 },
        { to: "eng/skill/wrap@1.0.0" },
      ),
    ).toEqual({
      needs: [need("eng/skill/lint@1.2.0 ^1.2.0"), need("eng/skill/wrap@1.0.0")],
      unusable: [
        { to: "eng/skill/fmt@1.0.0", range: "^2.0.0" },
        { to: "eng/skill/sort@1.0.0", range: ">= 1" },
        { to: "eng/skill/tidy@1.0.0", range: "3" },
      ],
    });
  });
});

describe("movesWithin", () => {
  /** `review`, needed by each dependent, which recorded what it asks of it. */
  function needing(...asked: (string | undefined)[]) {
    const lock = emptyLock();
    const row = {
      registry: "kit",
      id: undefined,
      name: "review",
      kind: "skill" as const,
      namespace: "eng",
      address: undefined,
      content: undefined,
      version: "0.3.4",
      path: "",
      digest: "",
      origin: undefined,
      links: [],
    };
    lock.artifacts.review = { ...row, neededBy: asked.map((_, at) => `agent-${at}`) };
    asked.forEach((at, index) => {
      lock.artifacts[`agent-${index}`] = {
        ...row,
        name: `agent-${index}`,
        kind: "agent",
        ...(at === undefined ? {} : { dependsOn: { review: at } }),
      };
    });
    return movesWithin(lock, "review");
  }

  it("moves within every dependent's range, and holds what any of them names exactly", () => {
    expect(needing("^0.3.2")).toBe("^0.3.2");
    expect(needing("^0.3.2", "~0.3.4")).toBe(">=0.3.4 <0.4.0");
    expect(needing("^0.3.2", "0.3.4")).toBeUndefined();
    expect(needing("^0.3.2", undefined)).toBeUndefined();
    expect(needing("^0.3.2", "^0.4.0")).toBeUndefined();
  });
});

describe("an edge that names no version", () => {
  it("takes the version its registry lists, and records none", () => {
    const result = closure(
      [selected("agent", "reviewer", "0.3.0")],
      registry(
        ["agent", "reviewer", "0.3.0", "eng/skill/review", "eng/skill/lint@1.0.0 ^1.0.0"],
        ["skill", "review", "0.5.0"],
        ["skill", "lint", "1.0.0"],
      ),
    );
    expect(result.unresolved).toEqual([]);
    expect(result.neededBy.get(id("skill", "review"))).toEqual(new Set([id("agent", "reviewer")]));
    expect(result.dependsOn.get(id("agent", "reviewer"))).toEqual(
      new Map([[id("skill", "lint"), "^1.0.0"]]),
    );
  });

  it("is asked for without a version when its registry did not list it", () => {
    const result = closure(
      [selected("agent", "reviewer", "0.3.0")],
      registry(["agent", "reviewer", "0.3.0", "eng/skill/review"]),
    );
    const [missing] = result.unresolved;
    expect(missing?.need).toEqual(need("eng/skill/review"));
    expect(wantOf(missing?.need as Need)).toEqual({
      name: "review",
      namespace: "eng",
      kind: "skill",
    });
  });

  it("gives way to the range another edge asks for", () => {
    const result = closure(
      [selected("agent", "reviewer", "0.3.0"), selected("agent", "helper", "1.0.0")],
      registry(
        ["agent", "reviewer", "0.3.0", "eng/skill/review"],
        ["agent", "helper", "1.0.0", "eng/skill/review@1.0.0 ^1.0.0"],
        ["skill", "review", "0.5.0"],
      ),
    );
    expect(result.conflicts).toEqual([]);
    expect(result.unresolved.map(({ need }) => need.range)).toEqual(["^1.0.0"]);
  });
});
