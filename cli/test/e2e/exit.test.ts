import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { test } from "#test/kit/fixtures.ts";

// `process.exit()` can hang on Node 24 and 26 (nodejs/node#64274), so a finished command must
// end with its event loop. Each run is short, and one that hangs is killed and fails.
const COMMANDS = [["--version"], ["status", "--json"], ["list", "--json"], ["sync", "--dry-run"]];
const ROUNDS = 5;
const ACME = join(import.meta.dirname, "..", "..", "..", "examples", "acme-registry");

test("a finished command ends without calling process.exit", async ({ aireg, tmp }) => {
  const called = join(tmp, "exit-called");
  const watch = join(tmp, "watch-exit.mjs");
  await writeFile(
    watch,
    [
      'import { appendFileSync } from "node:fs";',
      "const exit = process.exit;",
      "process.exit = (code) => {",
      `  appendFileSync(${JSON.stringify(called)}, \`\${process.argv.slice(2).join(" ")}\\n\`);`,
      "  return exit(code);",
      "};",
      "",
    ].join("\n"),
  );
  expect((await aireg(["init", "-y", "--for", "claude-code"])).code).toBe(0);
  expect((await aireg(["add", ACME, "--select", "pr-review", "-y"])).code).toBe(0);

  for (let round = 0; round < ROUNDS; round++) {
    for (const args of COMMANDS) {
      const started = Date.now();
      const ran = await aireg(args, { node: ["--import", pathToFileURL(watch).href] });
      expect(ran.code, `${args.join(" ")}: ${ran.stderr}`).toBe(0);
      expect(Date.now() - started, args.join(" ")).toBeLessThan(15_000);
    }
  }
  expect(existsSync(called) ? await readFile(called, "utf8") : "").toBe("");
}, 120_000);
