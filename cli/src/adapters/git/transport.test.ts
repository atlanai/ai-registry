import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";
import { gitEnv } from "./env.ts";
import { attempts } from "./transport.ts";
import { parseSource } from "./url.ts";

/** A PATH with a `gh` on it, so the ladder offers the gh rung where it may. */
async function withGh(tmp: string): Promise<NodeJS.ProcessEnv> {
  const bin = join(tmp, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  await chmod(join(bin, "gh"), 0o755);
  return { PATH: bin };
}

describe("the clone ladder", () => {
  test("asks gh for a repository on github.com", async ({ tmp }) => {
    const env = await withGh(tmp);
    const labels = attempts(parseSource("https://github.com/acme/kit"), env).map((a) => a.label);
    expect(labels).toEqual(["https", "gh", "ssh"]);
  });

  test("never asks gh, which reads github.com, for a repository on another host", async ({
    tmp,
  }) => {
    const env = await withGh(tmp);
    const ladder = attempts(parseSource("https://git.example.com/acme/kit"), env);
    expect(ladder.map((a) => a.label)).toEqual(["https", "ssh"]);
  });

  test("never hands gh an owner it would read as a flag", async ({ tmp }) => {
    const env = await withGh(tmp);
    const ladder = attempts(parseSource("https://github.com/-uevil/kit"), env);
    expect(ladder.map((a) => a.label)).toEqual(["https", "ssh"]);
  });
});

describe("an address naming its own account or port", () => {
  test.for([
    ["an scp user", "org-123@github.com:acme/kit.git", "ssh"],
    ["an ssh user", "ssh://deploy@git.example.com/acme/kit.git", "ssh"],
    ["an https port", "https://git.example.com:8443/acme/kit", "https"],
  ] as const)("is tried only as written, for %s", async ([, input, label], { tmp }) => {
    const env = await withGh(tmp);
    const spec = parseSource(input);
    expect(attempts(spec, env)).toEqual([{ label, url: spec.location, config: [] }]);
  });

  test.for([
    ["git@github.com:acme/kit.git", ["ssh", "https"]],
    ["ssh://git@git.example.com:22/acme/kit.git", ["ssh", "https"]],
    ["https://user@github.com/acme/kit", ["https", "gh", "ssh"]],
  ] as const)("keeps every fallback for %s", async ([input, labels], { tmp }) => {
    const env = await withGh(tmp);
    expect(attempts(parseSource(input), env).map((a) => a.label)).toEqual(labels);
  });

  test("hands gh the whole github.com URL", async ({ tmp }) => {
    const env = await withGh(tmp);
    const gh = attempts(parseSource("github.com/acme/kit"), env).find((a) => a.label === "gh");
    expect(gh?.url).toBe("https://github.com/acme/kit");
  });
});

// Real git, asked for the credential the gh rung would send, so the helper line is proven to parse.
describe.skipIf(process.platform === "win32")("the gh rung", () => {
  test("signs git in with gh alone, never a gh planted where git works", async ({ tmp }) => {
    const bin = join(tmp, "bin");
    await mkdir(bin);
    const gh =
      '#!/bin/sh\n[ "$*" = "auth git-credential get" ] && printf "username=x\\npassword=from-gh\\n"\n';
    await writeFile(join(bin, "gh"), gh);
    await writeFile(join(tmp, "gh"), `#!/bin/sh\ntouch "${join(tmp, "planted.ran")}"\n`);
    await chmod(join(bin, "gh"), 0o755);
    await chmod(join(tmp, "gh"), 0o755);
    const global = join(tmp, "gitconfig");
    await writeFile(
      global,
      '[credential]\n\thelper = "!f() { echo username=stale; echo password=from-store; }; f"\n',
    );
    const env = { PATH: ["", ".", bin, process.env.PATH ?? ""].join(delimiter) };
    const rung = attempts(parseSource("github.com/acme/kit"), env).find((a) => a.label === "gh");
    const filled = spawnSync("git", [...(rung?.config ?? []), "credential", "fill"], {
      cwd: tmp,
      input: "protocol=https\nhost=github.com\npath=acme/kit\n\n",
      encoding: "utf8",
      env: gitEnv({ ...env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1" }),
    });
    expect(filled.stdout).toContain("password=from-gh");
    expect(filled.stdout).not.toContain("from-store");
    expect(existsSync(join(tmp, "planted.ran"))).toBe(false);
  });
});
