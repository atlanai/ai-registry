import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { lsRemote, peel, type RemoteRef, resolveRef } from "./resolve.ts";
import { parseSource, type SourceSpec } from "./url.ts";

const PEELED = "a496748000000000000000000000000000000bbb";

/** What `git ls-remote` prints for an annotated tag: the tag object, then the
 * commit it points at under the same name with `^{}` appended. */
const annotated: RemoteRef[] = [
  { commit: "21cea2a0000000000000000000000000000000aa", name: "refs/tags/v1.0.0" },
  { commit: PEELED, name: "refs/tags/v1.0.0^{}" },
];

const lightweight: RemoteRef[] = [{ commit: PEELED, name: "refs/tags/v1.1.0" }];

describe("peel", () => {
  it.each([
    [
      "takes the commit an annotated tag points at, not the tag object",
      annotated,
      "refs/tags/v1.0.0",
      PEELED,
    ],
    ["takes the only line a lightweight tag has", lightweight, "refs/tags/v1.1.0", PEELED],
    ["finds nothing for a ref that is not there", annotated, "refs/heads/main", undefined],
    [
      "does not mistake one tag's peeled line for another tag",
      annotated,
      "refs/tags/v1.0",
      undefined,
    ],
  ])("%s", (_, refs, name, commit) => {
    expect(peel(refs, name)?.commit).toBe(commit);
  });
});

describe("resolveRef", () => {
  // The stand-in git is a shell script, which Windows does not run.
  test.skipIf(process.platform === "win32")(
    "stops ls-remote at the limit the host sets, and names how to raise it",
    async ({ tmp }) => {
      const hung = join(tmp, "git");
      await writeFile(hung, "#!/bin/sh\nsleep 5\n");
      await chmod(hung, 0o755);
      vi.stubEnv("PATH", `${tmp}${delimiter}${process.env.PATH ?? ""}`);
      try {
        const spec: SourceSpec = {
          location: tmp,
          kind: "path",
          ref: undefined,
          alias: "x",
          slug: undefined,
          host: undefined,
        };
        const limits = { timeoutMs: 100, timeoutSetting: "AIREG_GIT_TIMEOUT_MS" };
        await expect(resolveRef(spec, undefined, limits)).rejects.toMatchObject({
          message: expect.stringMatching(/timed out/),
          hint: expect.stringContaining("AIREG_GIT_TIMEOUT_MS"),
        });
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});

describe("lsRemote", () => {
  // A stand-in git that answers only when gh signs it in, as a private repository does.
  test.skipIf(process.platform === "win32")(
    "tries the gh rung when https is refused",
    async ({ tmp }) => {
      const bin = join(tmp, "bin");
      const log = join(tmp, "calls.log");
      await mkdir(bin);
      await writeFile(
        join(bin, "git"),
        [
          "#!/bin/sh",
          `echo "$*" >> "${log}"`,
          `case "$*" in *"credential.helper=!'gh' auth git-credential"*)`,
          `  printf '%s\\tHEAD\\n' ${PEELED}; exit 0;;`,
          "esac",
          "echo \"fatal: Authentication failed for 'https://github.com/acme/kit.git/'\" >&2",
          "exit 128",
        ].join("\n"),
      );
      await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
      await chmod(join(bin, "git"), 0o755);
      await chmod(join(bin, "gh"), 0o755);
      vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
      try {
        const refs = await lsRemote(parseSource("https://github.com/acme/kit"), ["HEAD"], {
          timeoutMs: 60_000,
        });
        expect(refs).toEqual([{ commit: PEELED, name: "HEAD" }]);
      } finally {
        vi.unstubAllEnvs();
      }
      const calls = (await readFile(log, "utf8")).trim().split("\n");
      expect(calls).toEqual([
        "ls-remote -- https://github.com/acme/kit.git HEAD",
        "-c credential.helper= -c credential.helper=!'gh' auth git-credential ls-remote -- https://github.com/acme/kit HEAD",
      ]);
    },
  );
});
