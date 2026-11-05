import { describe, expect, test } from "vitest";
import { readIndex, readVersions, SpecError } from "./documents.ts";
import { mergedIndex, mergedVersions, newest, type OfferedVersion, specJson } from "./merge.ts";

const OFFER: OfferedVersion = {
  namespace: "mine",
  kind: "skill",
  name: "my-helper",
  version: "0.2.0",
  digest: "sha256:bbbb",
  description: "mine",
};

/** Serves one in-memory root, so the writer's output is read back by the real reader. */
function rootOf(documents: Readonly<Record<string, unknown>>) {
  return (path: string) => {
    const found = documents[path];
    return Promise.resolve(
      found === undefined ? undefined : new TextEncoder().encode(specJson(found)),
    );
  };
}

describe("mergedVersions", () => {
  test("adds a version above the ones before it, leaving them as written", () => {
    const existing = {
      namespace: "mine",
      kind: "skill",
      name: "my-helper",
      latest: "0.1.0",
      versions: [
        {
          version: "0.1.0",
          digest: "sha256:aaaa",
          published_at: "2026-01-01T00:00:00Z",
          status: "active",
          yanked: false,
          released_by: "someone",
        },
      ],
    };
    const document = mergedVersions(existing, OFFER, "2026-01-02T00:00:00Z");
    const versions = document.versions as Record<string, unknown>[];

    expect(versions.map((row) => row.version)).toEqual(["0.2.0", "0.1.0"]);
    // The old row survives untouched, `published_at` and `released_by` included.
    expect(versions[1]).toEqual(existing.versions[0]);
    expect(document.latest).toBe("0.2.0");
  });

  test("replaces a re-offered version in place, keeping its unmodeled fields", () => {
    const existing = {
      namespace: "mine",
      kind: "skill",
      name: "my-helper",
      latest: "0.2.0",
      versions: [
        { version: "0.2.0", digest: "sha256:stale", released_by: "someone" },
        { version: "0.3.0", digest: "sha256:cccc" },
      ],
    };
    const versions = mergedVersions(existing, OFFER, "2026-01-02T00:00:00Z").versions as Record<
      string,
      unknown
    >[];

    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ digest: "sha256:bbbb", released_by: "someone" });
    expect(versions[1]).toEqual({ version: "0.3.0", digest: "sha256:cccc" });
  });

  test("keeps latest on the highest active version when a lower one is offered", () => {
    const row = (version: string, yanked = false) => ({
      version,
      digest: `sha256:${version}`,
      published_at: "2026-01-01T00:00:00Z",
      status: "active",
      yanked,
    });
    const existing = {
      namespace: "mine",
      kind: "skill",
      name: "my-helper",
      latest: "1.0.0",
      versions: [row("1.0.0"), row("2.0.0", true)],
    };
    const backport = { ...OFFER, version: "0.1.1" };

    expect(mergedVersions(existing, backport, "2026-01-02T00:00:00Z").latest).toBe("1.0.0");
  });

  test("never makes a prerelease latest while a release is active", () => {
    const row = (version: string) => ({
      version,
      digest: `sha256:${version}`,
      published_at: "2026-01-01T00:00:00Z",
      status: "active",
      yanked: false,
    });
    const existing = {
      namespace: "mine",
      kind: "skill",
      name: "my-helper",
      latest: "0.2.0",
      versions: [row("0.1.0"), row("0.2.0")],
    };
    const candidate = { ...OFFER, version: "1.0.0-rc.1" };
    expect(mergedVersions(existing, candidate, "2026-01-02T00:00:00Z").latest).toBe("0.2.0");
    const only = { ...existing, latest: undefined, versions: [] };
    expect(mergedVersions(only, candidate, "2026-01-02T00:00:00Z").latest).toBe("1.0.0-rc.1");
  });

  test("lists a backport below every version that outranks it", () => {
    const existing = {
      namespace: "mine",
      kind: "skill",
      name: "my-helper",
      latest: "2.0.0",
      versions: [{ version: "2.0.0" }, { version: "1.0.0" }],
    };
    const backport = { ...OFFER, version: "1.1.0" };
    const { versions } = mergedVersions(existing, backport, "2026-01-02T00:00:00Z");
    expect((versions as { version: string }[]).map((row) => row.version)).toEqual([
      "2.0.0",
      "1.1.0",
      "1.0.0",
    ]);
  });

  test("refuses a version the reader would reject", () => {
    expect(() => mergedVersions(undefined, { ...OFFER, version: "not a version" }, "x")).toThrow(
      SpecError,
    );
  });
});

describe("newest", () => {
  const latest = (...versions: string[]) =>
    newest(versions.map((version) => ({ version, status: "active", yanked: false })));

  test("puts a prerelease ahead of a version that does not parse, in either order", () => {
    expect(latest("2.0.0-beta", "2024-10-01")).toBe("2.0.0-beta");
    expect(latest("2024-10-01", "2.0.0-beta")).toBe("2.0.0-beta");
  });

  test("takes the first row among equals", () => {
    expect(latest("1.0.0+b", "1.0.0+a")).toBe("1.0.0+b");
  });

  test("takes the first row when no version parses", () => {
    expect(latest("2024-10-01", "2024-09-01")).toBe("2024-10-01");
    expect(latest("2024-09-01", "2024-10-01")).toBe("2024-09-01");
  });

  test("reads only strict SemVer, so a v prefix or a leading zero never outranks it", () => {
    expect(latest("1.0.0", "v1.0.0")).toBe("1.0.0");
    expect(latest("v1.0.0", "1.0.0")).toBe("1.0.0");
    expect(latest("1.2.0", "01.10.0")).toBe("1.2.0");
  });

  test("takes the highest release from a mixed list", () => {
    expect(latest("1.9.0", "2024-10-01", "1.10.0", "2.0.0-beta", "v2")).toBe("1.10.0");
  });
});

describe("mergedIndex", () => {
  test("upserts the offered row and leaves every other alone", () => {
    const existing = {
      format_version: 1,
      generated_at: "2026-01-01T00:00:00Z",
      entries: [
        { namespace: "acme", kind: "skill", name: "deploy", latest: "1.0.0", digest: "sha256:d" },
        { namespace: "mine", kind: "skill", name: "my-helper", latest: "0.1.0", digest: "old" },
      ],
    };
    const document = mergedIndex(existing, [OFFER], "2026-01-02T00:00:00Z");
    const entries = document.entries as Record<string, unknown>[];

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(existing.entries[0]);
    expect(entries[1]).toMatchObject({ latest: "0.2.0", digest: "sha256:bbbb" });
    expect(document.generated_at).toBe("2026-01-02T00:00:00Z");
  });

  test("keys on namespace, kind and name together", () => {
    const existing = {
      entries: [
        { namespace: "mine", kind: "agent", name: "my-helper", latest: "9.9.9", digest: "a" },
      ],
    };
    const entries = mergedIndex(existing, [OFFER], "2026-01-02T00:00:00Z").entries as unknown[];
    expect(entries).toHaveLength(2);
  });
});

describe("what it writes, the reader reads", () => {
  test("round-trips through readVersions and readIndex", async () => {
    const versions = mergedVersions(undefined, OFFER, "2026-01-02T00:00:00Z");
    const index = mergedIndex(undefined, [OFFER], "2026-01-02T00:00:00Z");
    const read = rootOf({
      "artifacts/mine/skill/my-helper/versions.json": versions,
      "index.json": index,
    });

    const back = await readVersions(read, "mine", "skill", "my-helper");
    expect(back.latest).toBe("0.2.0");
    expect(back.versions).toEqual([
      { version: "0.2.0", digest: "sha256:bbbb", status: "active", yanked: false },
    ]);

    expect(await readIndex(read)).toEqual([
      {
        namespace: "mine",
        kind: "skill",
        name: "my-helper",
        latest: "0.2.0",
        digest: "sha256:bbbb",
        status: "active",
        description: "mine",
      },
    ]);
  });
});
