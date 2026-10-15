import { join } from "node:path";
import { describe, expect } from "vitest";
import { registry } from "#test/kit/builders/registry.ts";
import { test } from "#test/kit/fixtures.ts";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

describe("aireg doctor, for the aireg skills", () => {
  test("says when another release is installed, and its printed commands settle it", async ({
    aireg,
    git,
    tmp,
  }) => {
    // The built CLI carries package.json's version, a release's, as a published build does.
    const version = (await aireg(["--version"])).stdout.trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const repo = join(tmp, "ai-registry");
    await registry(repo).skill("aireg/add@0.1.0").write();
    await git.init(repo);
    await git.commit(repo, "skills");
    await git.tag(repo, "aireg-v0.0.1");
    await git.tag(repo, `aireg-v${version}`);
    const skills = async () => {
      const { data } = JSON.parse((await aireg(["doctor", "--json"])).stdout);
      return (data.checks as Check[]).find((check) => check.name === "aireg skills");
    };
    const declare = ["registry", "add", `file://${repo}`, "--as", "ai-registry", "-g"];
    expect((await aireg([...declare, "--ref", "aireg-v0.0.1"])).code).toBe(0);
    expect((await aireg(["add", "ai-registry/aireg", "-g", "--yes"])).code).toBe(0);

    const stale = await skills();
    expect(stale).toMatchObject({
      ok: true,
      detail: `pinned to aireg-v0.0.1, but aireg is ${version}`,
    });
    expect((await aireg(["doctor"])).stdout).toMatch(/!\s+aireg skills\s+pinned to aireg-v0\.0\.1/);
    const [declared, added] = (stale?.fix ?? "").split(" && ").map((command) => command.split(" "));
    expect(declared).toEqual([
      "aireg",
      ...declare.slice(0, 3),
      "--ref",
      `aireg-v${version}`,
      "--as",
      "ai-registry",
      "-g",
    ]);

    // Declared but not yet added, the old release is still what is installed.
    expect((await aireg((declared ?? []).slice(1))).code).toBe(0);
    expect((await skills())?.detail).toBe(`pinned to aireg-v0.0.1, but aireg is ${version}`);
    expect((await aireg((added ?? []).slice(1))).code).toBe(0);
    expect(await skills()).toEqual({ name: "aireg skills", ok: true, detail: "installed" });
  }, 60_000);
});
