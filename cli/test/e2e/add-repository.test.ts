import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";

const ACME = join(import.meta.dirname, "..", "..", "..", "examples", "acme-registry");

test("reports a GitHub repository no scope declares as a new registry", async ({
  aireg,
  git,
  tmp,
}) => {
  const source = join(tmp, "source");
  await cp(ACME, source, { recursive: true });
  await git.init(source);
  await git.commit(source);
  await mkdir(join(tmp, "remotes", "acme"), { recursive: true });
  await git(tmp, "clone", "--quiet", "--bare", source, join(tmp, "remotes", "acme", "skills.git"));
  // git reads github.com from a local folder, so the add runs without a network.
  const env = {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `url.file://${join(tmp, "remotes")}/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/",
    GIT_CONFIG_KEY_1: "protocol.file.allow",
    GIT_CONFIG_VALUE_1: "always",
  };
  expect((await aireg(["init", "-y"])).code).toBe(0);

  const added = await aireg(
    ["add", "github.com/acme/skills/engineering/pr-review", "-y", "--for", "claude-code"],
    { env },
  );
  expect(added.code, added.stderr).toBe(0);
  expect(added.stdout).toContain("Added registry skills at github.com/acme/skills.");
});
