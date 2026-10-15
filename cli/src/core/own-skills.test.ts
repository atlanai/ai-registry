import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyLock, writeLock } from "#core/lock.ts";
import { roots } from "#core/store/paths.ts";
import { test } from "#test/kit/fixtures.ts";
import { ownSkillsCommand, ownSkillsRef, staleOwnSkillsPin } from "./own-skills.ts";

describe("ownSkillsRef", () => {
  it("is the tag the release workflow creates for a release build", () => {
    expect(ownSkillsRef("1.2.3")).toBe("aireg-v1.2.3");
  });

  it("is nothing for a development build, which no tag names", () => {
    expect(ownSkillsRef("0.0.0-dev")).toBeUndefined();
    expect(ownSkillsRef("1.2.3-dev.4")).toBeUndefined();
  });
});

describe("ownSkillsCommand", () => {
  it("pins the registry to the release and names it as setup does", () => {
    expect(ownSkillsCommand("aireg", "1.2.3")).toBe(
      "aireg registry add github.com/atlanai/ai-registry --path examples/aireg --ref aireg-v1.2.3 --as ai-registry -g && aireg add ai-registry/aireg -g",
    );
  });

  it("follows the default branch only when there is no release to pin", () => {
    expect(ownSkillsCommand("aireg", "1.2.3-dev.4")).not.toContain("--ref");
  });
});

describe("staleOwnSkillsPin", () => {
  afterEach(() => vi.unstubAllEnvs());

  /** Installed at `locked`, as the lockfile says, and declared at `declared` in the manifest. */
  const pinned = async (
    tmp: string,
    locked: string | undefined,
    version: string,
    { declared = locked, location = "github.com/atlanai/ai-registry" } = {},
  ) => {
    const scope = join(tmp, "registry");
    vi.stubEnv("AIREG_USER_SCOPE", scope);
    await mkdir(scope, { recursive: true });
    const ref = (value: string | undefined) => (value === undefined ? {} : { ref: value });
    await writeFile(
      join(scope, "manifest.yml"),
      `registries:\n  ai-registry:\n    source: ${JSON.stringify(location)}\n${declared === undefined ? "" : `    ref: ${declared}\n`}    path: examples/aireg\nartifacts: []\n`,
    );
    const lock = emptyLock();
    lock.registries["ai-registry"] = {
      location,
      adapter: "git",
      key: "key",
      config: { ...ref(locked), path: "examples/aireg" },
      revision: "abc",
    };
    lock.artifacts.add = {
      registry: "ai-registry",
      id: "aireg/skills/add",
      name: "add",
      kind: "skill",
      namespace: "aireg",
      address: "aireg/skills/add",
      path: "artifacts/add",
      origin: undefined,
      content: "",
      version: "0.1.0",
      digest: "",
      links: [],
    };
    await writeLock(roots("user", tmp), lock);
    return staleOwnSkillsPin(tmp, version);
  };

  test("names the release installed when it is another one, with what pins this one", async ({
    tmp,
  }) => {
    expect(await pinned(tmp, "aireg-v0.1.0", "0.1.2")).toEqual({
      pinned: "aireg-v0.1.0",
      fix: "aireg registry add github.com/atlanai/ai-registry --path examples/aireg --ref aireg-v0.1.2 --as ai-registry -g && aireg add ai-registry/aireg -g",
    });
  });

  test("goes by what is installed, so a new ref declared but not yet added still warns", async ({
    tmp,
  }) => {
    const found = await pinned(tmp, "aireg-v0.1.0", "0.1.2", { declared: "aireg-v0.1.2" });
    expect(found?.pinned).toBe("aireg-v0.1.0");
  });

  test("keeps the address your user scope declares, quoted for a shell", async ({ tmp }) => {
    const found = await pinned(tmp, "aireg-v0.1.0", "0.1.2", { location: "/srv/my mirror" });
    expect(found?.fix).toContain("aireg registry add '/srv/my mirror' --path examples/aireg");
  });

  test("is nothing for this release's tag, a ref that names no release, or no ref", async ({
    tmp,
  }) => {
    expect(await pinned(tmp, "aireg-v0.1.2", "0.1.2")).toBeUndefined();
    expect(await pinned(tmp, "main", "0.1.2")).toBeUndefined();
    expect(await pinned(tmp, "aireg-v0.1.0-rc.1", "0.1.2")).toBeUndefined();
    expect(await pinned(tmp, undefined, "0.1.2")).toBeUndefined();
  });

  test("is nothing for a development build, which pins nothing", async ({ tmp }) => {
    expect(await pinned(tmp, "aireg-v0.1.0", "0.0.0-dev")).toBeUndefined();
  });
});
