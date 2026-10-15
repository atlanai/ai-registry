import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Lock } from "#core/lock.ts";
import { LOCK_VERSION } from "#core/lock.ts";
import { artifactPath, projectionDir, roots } from "#core/store/paths.ts";
import type { Survey } from "./model.ts";
import { status, worstState } from "./status.ts";

const base = roots("project", "/work");
// Derived, so a change to either layout cannot silently break these.
const COPY = artifactPath(base, "kit", undefined, "skill", "lint", "skills/lint");
const PLUGIN = projectionDir(base, "kit", undefined);
const INSIDE = ".registry/artifacts/kit/kit/skills/lint";
const AT = ".claude/skills/kit";

const lock: Lock = {
  version: LOCK_VERSION,
  registries: {
    kit: {
      location: "acme/kit",
      adapter: "git",
      key: "sha256:src",
      config: {},
      revision: undefined,
    },
  },
  artifacts: {
    lint: {
      registry: "kit",
      id: "skills/lint",
      name: "lint",
      kind: "skill",
      namespace: undefined,
      address: "skills/lint",
      path: "artifacts/copy",
      origin: undefined,
      content: "t",
      version: undefined,
      digest: "sha256:1",
      links: [
        { harness: "claude", path: INSIDE, mode: "symlink" },
        { harness: "claude", path: AT, mode: "symlink" },
      ],
    },
  },
};

function survey(over: Partial<Survey["artifacts"]["lint"]> = {}): Survey {
  return {
    artifacts: {
      lint: {
        staged: true,
        digest: "sha256:1",
        links: {
          [INSIDE]: { present: true, isLink: true, target: COPY, mode: "symlink" },
          [AT]: { present: true, isLink: true, target: PLUGIN, mode: "symlink" },
        },
        ...over,
      },
    },
  };
}

describe("status", () => {
  it("reports ok when disk matches the lock", () => {
    expect(status(lock, survey(), base)[0]?.state).toBe("ok");
  });

  it("reports edited when the project copy was edited", () => {
    expect(status(lock, survey({ digest: "sha256:other" }), base)[0]?.state).toBe("edited");
  });

  it("reports missing when nothing is staged", () => {
    expect(status(lock, survey({ staged: false, digest: undefined }), base)[0]?.state).toBe(
      "missing",
    );
  });

  it("reports dangling when a link points outside this scope's own trees", () => {
    const off = survey({
      links: {
        [INSIDE]: { present: true, isLink: true, target: "/elsewhere", mode: "symlink" },
        [AT]: { present: true, isLink: true, target: PLUGIN, mode: "symlink" },
      },
    });
    expect(status(lock, off, base)[0]).toMatchObject({
      state: "dangling",
      detail: `claude: links to ${resolve("/elsewhere")}, not to aireg's copy`,
    });
  });

  it("says a link a folder of yours took the place of was replaced by you", () => {
    const yours = survey({
      links: {
        [INSIDE]: { present: true, isLink: false, target: undefined, mode: "symlink" },
        [AT]: { present: true, isLink: true, target: PLUGIN, mode: "symlink" },
      },
    });
    expect(status(lock, yours, base)[0]).toMatchObject({
      state: "dangling",
      detail: "claude: replaced by something of yours",
      harnesses: { claude: "replaced" },
    });
  });

  it("says which scope has no content", () => {
    const empty = survey({ staged: false, digest: undefined });
    expect(status(lock, empty, base)[0]?.detail).toBe("no content in this project");
    expect(status(lock, empty, roots("user", "/work"))[0]?.detail).toBe(
      "no content in your user scope",
    );
  });

  it("takes the worst state across artifacts", () => {
    expect(
      worstState([
        { name: "a", state: "ok", detail: undefined, harnesses: {} },
        { name: "b", state: "edited", detail: undefined, harnesses: {} },
      ]),
    ).toBe("edited");
  });
});

describe("links that could not be made", () => {
  const blockedLock = (blocked: NonNullable<Lock["artifacts"][string]["blocked"]>): Lock => {
    const row = lock.artifacts.lint;
    if (row === undefined) throw new Error("no row");
    return { ...lock, artifacts: { lint: { ...row, blocked } } };
  };

  it("are missing, naming what holds the path", () => {
    const [mine] = status(
      blockedLock([{ harness: "codex", path: ".agents/skills/lint" }]),
      survey(),
      base,
    );
    expect(mine).toMatchObject({ state: "missing", blocked: true });
    expect(mine?.detail).toBe("codex: something of yours is at .agents/skills/lint");
    const [theirs] = status(
      blockedLock([{ harness: "codex", path: ".agents/skills/lint", by: "kit/other/skill/lint" }]),
      survey(),
      base,
    );
    expect(theirs?.detail).toBe("codex: kit/other/skill/lint is installed at .agents/skills/lint");
  });
});
