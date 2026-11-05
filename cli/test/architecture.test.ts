import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const PACKAGE = resolve(SRC, "..");

/**
 * Each folder under `src/` by rank: a folder imports its own files and those
 * of lower ranks. Folders that share a rank do not import each other.
 */
const RANKS: Record<string, number> = {
  "main.ts": 7,
  cli: 6,
  daemon: 5,
  self: 4,
  engine: 4,
  accounts: 3,
  adapters: 3,
  core: 2,
  targets: 1,
  adapter: 0,
};

/** Edges a rule would refuse but the design needs, each with its reason. */
const ALLOWED: readonly { from: string; to: string; why: string }[] = [];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const SPECIFIER =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\bvi\.(?:mock|doMock|importActual)\(\s*)["']((?:\.{1,2}\/|#)[^"']+)["']/g;

const IMPORTS = (
  JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as {
    imports: Record<string, string>;
  }
).imports;

/** Where `#name` or `#name/rest` points, by the package's own imports map. */
function aliased(specifier: string): string {
  const exact = IMPORTS[specifier];
  if (exact !== undefined) return resolve(PACKAGE, exact);
  for (const [pattern, target] of Object.entries(IMPORTS)) {
    const prefix = pattern.replace(/\*$/, "");
    if (pattern.endsWith("*") && specifier.startsWith(prefix)) {
      return resolve(PACKAGE, target.replace(/\*$/, "") + specifier.slice(prefix.length));
    }
  }
  throw new Error(`${specifier} is not in package.json imports`);
}

/** Every import in `src`, as paths relative to the package with forward slashes. */
function edges(): { from: string; to: string }[] {
  const posix = (path: string) => path.split(sep).join("/");
  return sources(SRC).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(SPECIFIER)].map((match) => {
      const specifier = match[1] as string;
      const target = specifier.startsWith("#")
        ? aliased(specifier)
        : resolve(dirname(file), specifier);
      return { from: posix(relative(PACKAGE, file)), to: posix(relative(PACKAGE, target)) };
    }),
  );
}

const under = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
/** The folder under `src/` a path sits in, such as `core` for `src/core/errors.ts`. */
const layer = (path: string) => path.split("/")[1] ?? "";
/** The folder one level below `parent`, such as `git` for `adapters/git/api.ts`. */
const child = (path: string, parent: string) =>
  under(path, parent) && path.split("/").length > 2 ? path.split("/")[1] : undefined;
/** A built-in adapter's entry points: its api module, and the registration of every one. */
const adapterEntry = (path: string) =>
  path === "adapters/index.ts" || /^adapters\/[^/]+\/api\.ts$/.test(path);

/**
 * Test files keep the rules of the folder they sit in, and may also use the shared
 * kit in `test/`. Paths here are relative to `src/`.
 */
function refusal(from: string, to: string, test: boolean): string | undefined {
  if (!under(to, "src")) {
    const outside = to === "package.json" || under(to, "schema") || (test && under(to, "test"));
    return outside ? undefined : "src imports only src, package.json and schema/; tests also test/";
  }
  return layerRefusal(from.slice("src/".length), to.slice("src/".length));
}

function layerRefusal(from: string, to: string): string | undefined {
  if (to === "main.ts") return "main.ts is the entry point, imported by nobody";
  if (under(from, "adapter") && !under(to, "adapter")) return "the adapter contract stands alone";

  if (under(from, "targets") && !under(to, "targets")) {
    // The contract sits in core, which loads the built-in targets.
    return to === "core/target/contract.ts"
      ? undefined
      : "a target definition imports only the target contract";
  }

  const adapter = child(from, "adapters");
  if (adapter !== undefined && child(to, "adapters") !== adapter && !under(to, "adapter")) {
    return "a built-in adapter is written like any other: on the public contract alone";
  }

  const reached = child(to, "adapters");
  if (reached !== undefined && child(from, "adapters") !== reached) {
    // The registration loads each adapter lazily, through its entry module.
    const registered = from === "adapters/index.ts" && to === `adapters/${reached}/index.ts`;
    if (!registered && to !== `adapters/${reached}/api.ts`) {
      return "a built-in adapter is reached through its api module";
    }
  }

  const source = layer(`src/${from}`);
  const target = layer(`src/${to}`);
  const rank = RANKS[source];
  const below = RANKS[target];
  if (rank === undefined || below === undefined) return `${source} or ${target} has no rank`;
  if (source === target || below < rank) return undefined;
  if (below === rank && source === "accounts" && adapterEntry(to)) return undefined;
  return below === rank
    ? `${source} and ${target} share a rank, so neither imports the other`
    : `${target} sits above ${source}`;
}

describe("architecture", () => {
  test("ranks every folder under src", () => {
    const unranked = readdirSync(SRC).filter((name) => RANKS[name] === undefined);
    expect(unranked).toEqual([]);
  });

  test("keeps every import inside the layering rules", () => {
    const broken = edges()
      .filter(
        ({ from, to }) => !ALLOWED.some((edge) => edge.from === from && to.startsWith(edge.to)),
      )
      .flatMap(({ from, to }) => {
        const why = refusal(from, to, from.endsWith(".test.ts"));
        return why === undefined ? [] : [`${from} -> ${to}: ${why}`];
      });
    expect(broken).toEqual([]);
  });

  test("keeps every allowance in use", () => {
    const found = edges();
    const stale = ALLOWED.filter(
      (edge) => !found.some(({ from, to }) => from === edge.from && to.startsWith(edge.to)),
    );
    expect(stale).toEqual([]);
  });

  test("gives every built-in adapter the scaffold's layout and an api module", () => {
    const root = join(SRC, "adapters");
    const missing = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        ["README.md", "index.ts", "connect.ts", "errors.ts", "api.ts", "compliance.test.ts"]
          .filter((file) => !existsSync(join(root, entry.name, file)))
          .map((file) => `adapters/${entry.name}/${file}`),
      );
    expect(missing).toEqual([]);
  });

  test("climbs with ../ only inside the published contract", () => {
    // tsconfig.types.json builds the contract's declarations alone, where `#adapter/` does not resolve.
    const contract = join(SRC, "adapter");
    // Its template text holds the import lines of the package it writes.
    const scaffold = join(SRC, "cli", "commands", "adapter", "init.ts");
    const allowed = (file: string, specifier: string) =>
      file === scaffold ||
      (file.startsWith(contract) && resolve(dirname(file), specifier).startsWith(contract));
    const climbing = ["src", "test", "scripts", "packaging"]
      .map((name) => join(PACKAGE, name))
      .flatMap(sources)
      .flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(SPECIFIER)]
          .map((match) => match[1] as string)
          .filter((specifier) => specifier.startsWith("../") && !allowed(file, specifier))
          .map((specifier) => `${relative(PACKAGE, file)}: ${specifier}`),
      );
    expect(climbing).toEqual([]);
  });

  test("imports with ./ only from the importing file's own folder", () => {
    const contract = join(SRC, "adapter");
    const descending = ["src", "test", "scripts", "packaging"]
      .map((name) => join(PACKAGE, name))
      .flatMap(sources)
      .filter((file) => !file.startsWith(contract))
      .flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(SPECIFIER)]
          .map((match) => match[1] as string)
          .filter((specifier) => specifier.startsWith("./") && specifier.slice(2).includes("/"))
          .map((specifier) => `${relative(PACKAGE, file)}: ${specifier}`),
      );
    expect(descending).toEqual([]);
  });
});

// The CLI writes escape sequences, so a literal control byte can hide in a template literal.
test("no source file holds a literal control byte", () => {
  const found = sources(SRC).filter((file) =>
    [...readFileSync(file, "utf8")].some(
      (char) => char.charCodeAt(0) < 32 && char !== "\n" && char !== "\t",
    ),
  );
  expect(found.map((file) => relative(PACKAGE, file))).toEqual([]);
});
