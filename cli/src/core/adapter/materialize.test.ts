import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import {
  AdapterError,
  type Artifact,
  type ArtifactKind,
  buildEnvelope,
  type FileRef,
  type SourceHandle,
} from "#adapter/index.ts";
import { test } from "#test/kit/fixtures.ts";
import { copyDescribed, materialize } from "./materialize.ts";

/** This test's folder, which the kit removes after it. */
let scratch: string;
test.beforeEach(({ tmp }) => {
  scratch = tmp;
});

/** A cache folder keyed by content digest, the way the client lays one out. */
function keyed(dir: string): (contentId: string) => string {
  return (contentId) => join(dir, contentId.replace(/^sha256:/, ""));
}

function bytesOf(path: string): Uint8Array {
  return new TextEncoder().encode(`contents of ${path}`);
}

function artifact(id: string, kind: ArtifactKind, name: string, paths: string[]): Artifact {
  return {
    id,
    kind,
    envelope: buildEnvelope({
      kind,
      metadata: { name },
      files: paths.map((path) => {
        const bytes = bytesOf(path);
        return {
          path,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          size: bytes.byteLength,
        };
      }),
    }),
    files: paths.map((path) => ({ path, locator: path, executable: false })),
  };
}

/** A plugin laid out the way the client addresses a plugin's contents. */
function plugin(...members: string[]): Artifact {
  return artifact("workspace:team", "plugin", "team", [
    ".claude-plugin/plugin.json",
    ...members.map((name) => `skills/${name}/SKILL.md`),
  ]);
}

function serving(withheld: ReadonlySet<string>, tampered: ReadonlySet<string> = new Set()) {
  return {
    fetch: async (_artifact: Artifact, ref: FileRef) => {
      if (withheld.has(ref.path)) {
        throw new AdapterError("test", "not_found", `${ref.path} is gone`);
      }
      // What a CDN injecting a script into an HTML response looks like from
      // here: the right file, more bytes than were described.
      if (tampered.has(ref.path)) {
        return new TextEncoder().encode(`${new TextDecoder().decode(bytesOf(ref.path))} <script/>`);
      }
      return bytesOf(ref.path);
    },
    resolve: async () => ({ artifacts: [] }),
    close: async () => {},
  } as unknown as SourceHandle;
}

describe("materialize", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function into(work: (home: string) => Promise<void>): Promise<void> {
    const home = await mkdtemp(join(scratch, "aireg-content-test-"));
    vi.stubEnv("AIREG_HOME", home);
    await work(home);
  }

  test("installs the members a collection can serve and drops the one it cannot", async () => {
    await into(async (home) => {
      const withheld = new Set(["skills/gone/SKILL.md"]);
      const { path } = await materialize("test", serving(withheld), plugin("kept", "gone"), {
        into: keyed(join(home, "mirror", "kept")),
      });

      expect((await readdir(join(path, "skills"))).sort()).toEqual(["kept"]);
      expect(await readdir(join(path, ".claude-plugin"))).toEqual(["plugin.json"]);
    });
  });

  test("keys a short collection on what arrived, never on the whole one's id", async () => {
    await into(async (home) => {
      const whole = plugin("kept", "gone");
      const cache = keyed(join(home, "mirror"));
      const short = await materialize("test", serving(new Set(["skills/gone/SKILL.md"])), whole, {
        into: cache,
      });
      // The same cache, so a partial tree under the whole one's key would answer here.
      const full = await materialize("test", serving(new Set()), whole, { into: cache });

      expect(short.contentId).not.toBe(full.contentId);
      expect(full.dropped).toEqual([]);
      expect((await readdir(join(full.path, "skills"))).sort()).toEqual(["gone", "kept"]);
      expect(short.envelope.files.map((file) => file.path)).not.toContain("skills/gone/SKILL.md");
    });
  });

  test("reuses a cached copy only once it matches the envelope asking for it", async () => {
    await into(async (home) => {
      const skill = artifact("s1", "skill", "lint", ["SKILL.md"]);
      const cache = keyed(join(home, "mirror"));
      // Bytes another registry left under this digest's folder.
      const seeded = cache(skill.envelope.metadata.digest ?? "");
      await mkdir(seeded, { recursive: true });
      await writeFile(join(seeded, "SKILL.md"), "THIS IS THE evil CONTENT");

      const staged = await materialize("test", serving(new Set()), skill, { into: cache });
      expect(await readFile(join(staged.root, "SKILL.md"), "utf8")).toBe("contents of SKILL.md");
    });
  });

  test("reads a cached copy that checks out without fetching it again", async () => {
    await into(async (home) => {
      const skill = artifact("s1", "skill", "lint", ["SKILL.md"]);
      const cache = keyed(join(home, "mirror"));
      await materialize("test", serving(new Set()), skill, { into: cache });
      const offline = {
        ...serving(new Set()),
        fetch: async () => {
          throw new Error("fetched again");
        },
      } as SourceHandle;

      const staged = await materialize("test", offline, skill, { into: cache });
      expect(await readFile(join(staged.root, "SKILL.md"), "utf8")).toBe("contents of SKILL.md");
    });
  });

  test("copies only what the envelope describes out of a fetched copy", async () => {
    await into(async (home) => {
      const skill = artifact("s1", "skill", "lint", ["SKILL.md"]);
      const staged = await materialize("test", serving(new Set()), skill, {
        into: keyed(join(home, "mirror")),
      });
      await writeFile(join(home, "secret"), "private key");
      await symlink(join(home, "secret"), join(staged.root, "leak.txt"));
      await writeFile(join(staged.root, "added.sh"), "undescribed");

      await copyDescribed(staged, join(home, "copy"));
      expect(await readdir(join(home, "copy"))).toEqual(["SKILL.md"]);
    });
  });

  test("fails a collection the source will not serve at all", async () => {
    await into(async (home) => {
      const withheld = new Set([
        "skills/a/SKILL.md",
        "skills/b/SKILL.md",
        ".claude-plugin/plugin.json",
      ]);
      await expect(
        materialize("test", serving(withheld), plugin("a", "b"), {
          into: keyed(join(home, "mirror", "none")),
        }),
      ).rejects.toThrow(/served none of its/);
    });
  });

  test("still fails one artifact whose file is gone, because it is not a collection", async () => {
    await into(async (home) => {
      const skill = artifact("s1", "skill", "lint", ["SKILL.md", "reference.md"]);
      await expect(
        materialize("test", serving(new Set(["reference.md"])), skill, {
          into: keyed(join(home, "mirror", "lint")),
        }),
      ).rejects.toThrow(/is gone/);
    });
  });
});

describe("materialize, when a member arrives as something else", () => {
  async function into(work: (home: string) => Promise<void>): Promise<void> {
    const home = await mkdtemp(join(scratch, "aireg-content-tamper-"));
    vi.stubEnv("AIREG_HOME", home);
    try {
      await work(home);
    } finally {
      vi.unstubAllEnvs();
    }
  }

  // Dropping the member is the safe half of the choice: the bytes never land
  // either way, and the rest of the namespace still installs.
  test("drops the member and keeps the others", async () => {
    await into(async (home) => {
      const session = serving(new Set(), new Set(["skills/bad/SKILL.md"]));
      const { path, dropped } = await materialize("test", session, plugin("good", "bad"), {
        into: keyed(join(home, "mirror", "good")),
      });

      expect((await readdir(join(path, "skills"))).sort()).toEqual(["good"]);
      expect(dropped.map((item) => item.member)).toEqual(["skills/bad"]);
      expect(dropped[0]?.reason).toMatch(/arrived as \d+ bytes, but \d+ were described/);
    });
  });

  test("still refuses a single artifact whose bytes do not match", async () => {
    await into(async (home) => {
      const session = serving(new Set(), new Set(["SKILL.md"]));
      const one = artifact("skills/lint", "skill", "lint", ["SKILL.md"]);
      await expect(
        materialize("test", session, one, { into: keyed(join(home, "mirror", "lint")) }),
      ).rejects.toThrow(/were described/);
    });
  });
});

describe("a version read where its source keeps it", () => {
  async function inPlace(
    work: (version: string, home: string, handle: SourceHandle) => Promise<void>,
  ): Promise<void> {
    const home = await mkdtemp(join(scratch, "aireg-content-local-"));
    vi.stubEnv("AIREG_HOME", home);
    const version = join(home, "registry", "lint", "1.0.0");
    await mkdir(version, { recursive: true });
    await writeFile(join(home, "secret"), "private key");
    const handle = { ...serving(new Set()), localRoot: async () => version } as SourceHandle;
    try {
      await work(version, home, handle);
    } finally {
      vi.unstubAllEnvs();
    }
  }

  test("copies only what the envelope describes, never what a link points at", async () => {
    await inPlace(async (version, home, handle) => {
      await writeFile(join(version, "SKILL.md"), bytesOf("SKILL.md"));
      await writeFile(join(version, "added.sh"), "undescribed");
      await symlink(join(home, "secret"), join(version, "leak.txt"));
      const one = artifact("skills/lint", "skill", "lint", ["SKILL.md"]);

      const staged = await materialize("test", handle, one, { into: keyed(join(home, "mirror")) });
      await copyDescribed(staged, join(home, "copy"));
      expect(await readdir(join(home, "copy"))).toEqual(["SKILL.md"]);
    });
  });

  test("streams each file into place rather than reading it whole", async () => {
    await inPlace(async (version, home, handle) => {
      await writeFile(join(version, "SKILL.md"), bytesOf("SKILL.md"));
      const one = artifact("skills/lint", "skill", "lint", ["SKILL.md"]);
      const staged = await materialize("test", handle, one, { into: keyed(join(home, "mirror")) });

      // Every whole-file read goes through a FileHandle, so counting those is
      // what tells a streamed copy from a buffered one.
      const probe = await open(join(version, "SKILL.md"));
      const fileHandle = Object.getPrototypeOf(probe) as {
        readFile: (...args: never[]) => unknown;
      };
      await probe.close();
      const original = fileHandle.readFile;
      let whole = 0;
      fileHandle.readFile = function (this: unknown, ...args: never[]) {
        whole += 1;
        return original.apply(this, args);
      };
      try {
        await copyDescribed(staged, join(home, "copy"));
      } finally {
        fileHandle.readFile = original;
      }
      expect(whole).toBe(0);
      expect(await readFile(join(home, "copy", "SKILL.md"))).toEqual(
        Buffer.from(bytesOf("SKILL.md")),
      );
    });
  });

  test("lands nothing, not even a partial file, when a copy no longer matches", async () => {
    await inPlace(async (version, home, handle) => {
      await writeFile(join(version, "SKILL.md"), bytesOf("SKILL.md"));
      const one = artifact("skills/lint", "skill", "lint", ["SKILL.md"]);
      const staged = await materialize("test", handle, one, { into: keyed(join(home, "mirror")) });
      await writeFile(join(version, "SKILL.md"), "edited since");

      await expect(copyDescribed(staged, join(home, "copy"))).rejects.toThrow(
        "lint: SKILL.md arrived as 12 bytes",
      );
      expect(await readdir(join(home, "copy"))).toEqual([]);
    });
  });

  test("refuses a described file that is a link, even to the bytes it describes", async () => {
    await inPlace(async (version, home, handle) => {
      await writeFile(join(home, "elsewhere.md"), bytesOf("SKILL.md"));
      await symlink(join(home, "elsewhere.md"), join(version, "SKILL.md"));
      const one = artifact("skills/lint", "skill", "lint", ["SKILL.md"]);

      await expect(
        materialize("test", handle, one, { into: keyed(join(home, "mirror")) }),
      ).rejects.toThrow("lint: SKILL.md is a symlink.");
    });
  });
});
