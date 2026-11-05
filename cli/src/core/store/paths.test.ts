import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect } from "vitest";
import { sanitizeName } from "#adapter/text.ts";
import { test } from "#test/kit/fixtures.ts";
import {
  adapterDataDir,
  adapterModulePath,
  adaptersDir,
  PROJECTIONS_DIR,
  roots,
  scopeFor,
  stateDir,
  toolHome,
  userScopeDir,
} from "./paths.ts";

describe("adapterDataDir", () => {
  test("sits beside a version directory, not inside one", () => {
    const env = { AIREG_HOME: "/tmp/aireg-home-paths" };
    expect(adapterDataDir("acme", env)).toBe(join(adaptersDir(env), "acme"));
    expect(adapterModulePath("acme", "1.4.0", "adapter.mjs", env)).toBe(
      join(adapterDataDir("acme", env), "1.4.0", "adapter.mjs"),
    );
  });
});

describe("the reserved directories", () => {
  // `artifacts/<registry>/…` is content and `artifacts/.<name>/` is ours: it holds
  // because `sanitizeName` strips the dot, so no alias can ever name one.
  test("cannot be named by any registry alias", () => {
    for (const reserved of [PROJECTIONS_DIR]) {
      expect(sanitizeName(reserved)).not.toBe(reserved);
      expect(sanitizeName(reserved).startsWith(".")).toBe(false);
    }
    expect(sanitizeName("..")).toBe("unnamed");
    expect(sanitizeName(".hidden")).toBe("hidden");
  });
});

describe("toolHome", () => {
  test("is ~/.aireg, whatever else sits in the home folder", ({ home }) => {
    const user = home.dir;
    expect(toolHome({})).toBe(join(user, ".aireg"));
    mkdirSync(join(user, ".registry"));
    expect(toolHome({})).toBe(join(user, ".aireg"));
  });

  test("takes AIREG_HOME, and never AIREG_USER_SCOPE, which names the user scope", ({ home }) => {
    const user = home.dir;
    expect(toolHome({ AIREG_HOME: "/a", AIREG_USER_SCOPE: "/b" })).toBe(resolve("/a"));
    expect(toolHome({ AIREG_USER_SCOPE: "/b" })).toBe(join(user, ".aireg"));
  });
});

describe("stateDir", () => {
  test("keeps the daemon's and the update check's files together under the home", () => {
    const env = { AIREG_HOME: "/tmp/aireg-home-paths" };
    expect(stateDir(env)).toBe(join(toolHome(env), "state"));
  });
});

describe("userScopeDir", () => {
  test("is ~/.registry, and never moves with AIREG_HOME", ({ home }) => {
    const user = home.dir;
    expect(userScopeDir({})).toBe(join(user, ".registry"));
    expect(userScopeDir({ AIREG_HOME: "/tool" })).toBe(join(user, ".registry"));
  });

  test("takes AIREG_USER_SCOPE as given", () => {
    expect(userScopeDir({ AIREG_HOME: "/tool", AIREG_USER_SCOPE: "/mine" })).toBe("/mine");
  });

  test("keeps every scope's files in its own .registry folder", ({ home }) => {
    const user = home.dir;
    expect(roots("user", "/anywhere", {}).manifest).toBe(join(user, ".registry", "manifest.yml"));
    expect(roots("user", "/anywhere", {}).lock).toBe(join(user, ".registry", "manifest.lock.yml"));
    expect(roots("project", "/app", {}).manifest).toBe(join("/app", ".registry", "manifest.yml"));
    expect(roots("project", "/app", {}).artifacts).toBe(join("/app", ".registry", "artifacts"));
    expect(scopeFor(join(user, ".registry"), {})).toBe("user");
    expect(scopeFor(user, {})).toBe("project");
  });
});
