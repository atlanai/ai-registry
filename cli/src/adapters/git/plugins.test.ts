import { describe, expect, it } from "vitest";
import { pluginFetcher } from "./plugins.ts";

const fetcher = pluginFetcher(
  { cacheDir: () => "", exclusive: (_key, run) => run() },
  { timeoutMs: 1000 },
  [],
  [],
);
const plugin = (type: string, location: string) => ({
  name: "far",
  type,
  location,
  path: undefined,
  ref: undefined,
  sha: undefined,
});

describe("pluginFetcher", () => {
  it("refuses a github source that is not owner/repo, before fetching anything", async () => {
    await expect(fetcher(plugin("github", "https://github.com/o/r"))).rejects.toThrow(
      'its repo, "https://github.com/o/r", is not owner/repo',
    );
  });

  it("refuses a transport with no security", async () => {
    for (const location of ["http://example.test/far.git", "git://example.test/far.git"]) {
      await expect(fetcher(plugin("url", location))).rejects.toThrow("has no transport security");
    }
  });

  it("refuses a path that leaves the repository", async () => {
    await expect(
      fetcher({ ...plugin("git-subdir", "file:///tmp/none"), path: "../outside" }),
    ).rejects.toThrow("is not a folder inside the repository");
  });
});
