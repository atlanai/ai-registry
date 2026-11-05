import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseVersion } from "#adapter/semver.ts";
import { plural, quoted } from "#adapter/text.ts";
import { needsInput } from "#cli/options/parse.ts";
import { parseAdapterId } from "#core/adapter/installed/want.ts";
import { isBuiltinAdapter } from "#core/adapter/load.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { refuseRedirect, writeFresh } from "#core/fs/fresh.ts";
import type { HostCommandContext } from "#core/host/extend.ts";
import { NAME, PACKAGE } from "#core/product.ts";
import { NODE_REQUIREMENT, VERSION } from "#core/version.ts";

interface Own {
  dir?: string | undefined;
}

export async function initAdapter(
  context: HostCommandContext,
  raw: string | undefined,
  common: { force: boolean; dryRun: boolean },
  own: Own,
): Promise<void> {
  if (raw === undefined) {
    throw needsInput("adapter init", "an id", "Name the adapter: `aireg adapter init <id>`.");
  }
  const id = parseAdapterId(raw);
  if (isBuiltinAdapter(id)) {
    throw new AiregError(`${quoted(id)} is built into aireg, so it cannot be scaffolded.`, {
      code: ErrorCode.Usage,
      hint: "Choose a new id, like acme.",
    });
  }
  const dir = resolve(context.cwd, own.dir ?? id);
  const planned = files(id);
  for (const path of Object.keys(planned))
    refuseRedirect(dir, join(dir, path), "Remove it, or choose another folder with `--dir`.");
  if (!common.force) {
    const existing = await readdir(dir).catch(() => undefined);
    if (existing !== undefined && existing.length > 0) {
      throw new AiregError(`${dir} already exists.`, {
        code: ErrorCode.Conflict,
        hint: "Pass `--force` to overwrite it.",
      });
    }
  }
  if (common.dryRun) {
    if (context.printer.format === "json") {
      context.printer.json({
        ok: true,
        data: { id, dir, files: Object.keys(planned), dryRun: true },
      });
      return;
    }
    context.printer.info(
      `Would write ${plural(Object.keys(planned).length, "file")} under ${dir}.`,
    );
    return;
  }
  for (const [path, body] of Object.entries(planned)) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    // `--force` replaces the file itself, never what it may point to.
    if (common.force) await writeAtomic(target, body);
    else await writeFresh(target, body, { shown: target, hint: "Pass `--force` to overwrite it." });
  }
  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: { id, dir, files: Object.keys(planned), dryRun: false },
    });
    return;
  }
  context.printer.success(`Wrote adapter ${id} at ${dir}.`);
  context.printer.note(
    "next",
    `cd ${relative(context.cwd, dir) || "."} && npm install && npm test`,
  );
}

/** The scaffolded package's files by path, for a package outside this repository. */
function files(id: string): Record<string, string> {
  const name = displayName(id);
  const range = contractRange();
  const host = `${id}.example.test`;
  return {
    "package.json": json({
      name: `${NAME}-adapter-${id}`,
      version: "0.1.0",
      description: `An aireg adapter that reads ${name} registries.`,
      type: "module",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      files: ["dist"],
      engines: { node: NODE_REQUIREMENT },
      scripts: { build: "tsc", test: "node --test test/*.test.ts" },
      peerDependencies: { [PACKAGE]: range },
      devDependencies: { [PACKAGE]: range, "@types/node": "^22.0.0", typescript: "^5.9.0" },
    }),
    "tsconfig.json": json({
      compilerOptions: {
        target: "es2023",
        lib: ["es2023"],
        module: "nodenext",
        moduleResolution: "nodenext",
        types: ["node"],
        strict: true,
        verbatimModuleSyntax: true,
        erasableSyntaxOnly: true,
        rewriteRelativeImportExtensions: true,
        declaration: true,
        skipLibCheck: true,
        rootDir: "src",
        outDir: "dist",
      },
      include: ["src"],
    }),
    ".gitignore": "node_modules/\ndist/\n",
    "src/index.ts": `import { defineAdapter } from "${PACKAGE}";
import { connect } from "./connect.ts";
import { ID } from "./errors.ts";

export default defineAdapter({
  id: ID,
  displayName: ${JSON.stringify(name)},
  artifactKinds: ["skill"],
  // aireg sends an address here when its host is one of these.
  dispatch: { hosts: [${JSON.stringify(host)}] },
  capabilities: {},
  connect,
});
`,
    "src/connect.ts": `import type { SourceContext, SourceHandle } from "${PACKAGE}";
import { fail } from "./errors.ts";

// resolve lists what the registry at context.source.location publishes; fetch returns a file's bytes.
export async function connect(_context: SourceContext): Promise<SourceHandle> {
  return {
    resolve: async () => ({ artifacts: [] }),
    fetch: async () => {
      throw fail("not_found", "This adapter does not fetch files yet.");
    },
    close: async () => {},
  };
}
`,
    "src/errors.ts": `import { AdapterError, type Failure } from "${PACKAGE}";

export const ID = ${JSON.stringify(id)};

export function fail(failure: Failure, message: string): AdapterError {
  return new AdapterError(ID, failure, message);
}
`,
    "test/compliance.test.ts": `import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertAdapterCompliance } from "${PACKAGE}";
import adapter from "../src/index.ts";

// Point the location at a registry this adapter can read, so every file it lists is fetched and checked.
test("${id} meets the adapter contract", async () => {
  await assertAdapterCompliance(adapter, {
    source: {
      registry: ${JSON.stringify(id)},
      location: ${JSON.stringify(`https://${host}/registry`)},
      config: {},
      key: ${JSON.stringify(`${id}-test`)},
    },
    credential: undefined,
    signal: new AbortController().signal,
    limits: { timeoutMs: 30_000, retries: 0 },
    onBytes: () => {},
    cacheDir: () => mkdtempSync(join(tmpdir(), "${id}-cache-")),
    exclusive: (_key, run) => run(),
  });
});
`,
    "README.md": `# ${NAME}-adapter-${id}

An adapter lets aireg read a kind of registry it does not read on its own. This one was written by \`aireg adapter init ${id}\`, and builds on the adapter contract that the \`${PACKAGE}\` package exports.

## Develop

\`\`\`sh
npm install
npm test         # the compliance test, run on src/ by Node
npm run build    # compiles src/ to dist/
\`\`\`

## Implement

- \`dispatch\` in \`src/index.ts\` names the hosts, URL schemes or local paths whose addresses aireg would send to this adapter.
- \`connect\` in \`src/connect.ts\` returns a handle: \`resolve\` lists each artifact with the file list that describes it, and \`fetch\` returns one file's bytes, which must match the digest that list gives.
- \`capabilities\` turns on publishing and sign-in; the compliance test checks that each one you turn on is implemented.

Point the compliance test at a registry your adapter can read, so it fetches and checks every file.
`,
  };
}

function displayName(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** A caret range: later patches of this minor while aireg is 0.x, later minors from 1.0 on. */
function contractRange(): string {
  const version = parseVersion(VERSION) ?? { major: 0, minor: 0 };
  return `^${version.major}.${version.minor}`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
