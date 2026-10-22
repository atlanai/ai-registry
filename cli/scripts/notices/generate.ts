import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NAME } from "#core/product.ts";
import { BUN_COMMIT, BUN_VERSION } from "#packaging/targets.ts";

const ROOT = join(import.meta.dirname, "..", "..");

/** Checked in and shipped beside every release. */
const NOTICES_FILE = join(ROOT, "THIRD_PARTY_NOTICES.txt");

const BUN_LICENSE = join(ROOT, "packaging", "licenses", "bun.md");

/** Licenses that need only the notice to travel with the code. Anything else needs review. */
const ALLOWED = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "CC0-1.0",
]);

const RULE = "-".repeat(80);
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

interface Listed {
  readonly paths: readonly string[];
}

interface Package {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  /** The package's own license and notice files, or empty when it ships none. */
  readonly texts: readonly string[];
}

/** One SPDX id, or an OR of ids where one is allowed; AND, WITH and nesting need a person. */
export function allowed(expression: string): boolean {
  const inner = expression.replace(/^\((.*)\)$/, "$1");
  if (/[()]| AND | WITH /.test(inner)) return false;
  return inner.split(" OR ").some((id) => ALLOWED.has(id));
}

/** Type definitions are never bundled, so a package without JavaScript ships nothing. */
function shipsJavaScript(dir: string): boolean {
  return readdirSync(dir, { withFileTypes: true }).some((entry) =>
    entry.isDirectory()
      ? entry.name !== "node_modules" && shipsJavaScript(join(dir, entry.name))
      : /\.[cm]?js$/.test(entry.name),
  );
}

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function byte(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function readPackage(dir: string): Package {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name: string;
    version: string;
    license?: string;
  };
  const files = readdirSync(dir)
    .filter((file) => LICENSE_FILE.test(file))
    .sort(byte);
  return {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license ?? "UNKNOWN",
    texts: files.map((file) => normalize(readFileSync(join(dir, file), "utf8"))),
  };
}

/** Every production package with JavaScript in it, once per version, in a stable order. */
function shippedPackages(): Package[] {
  const listed = JSON.parse(
    execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  ) as Record<string, Listed[]>;
  const dirs = Object.values(listed).flatMap((entries) => entries.flatMap((entry) => entry.paths));
  return [...new Set(dirs)]
    .filter(shipsJavaScript)
    .map(readPackage)
    .sort((a, b) => byte(a.name, b.name) || byte(a.version, b.version));
}

/** The vendored LICENSE.md must come from the Bun release builds pin. */
export function bunLicense(text: string, revision = BUN_COMMIT): string {
  const [source = "", ...body] = text.split("\n");
  if (!source.includes(`/${revision}/`)) {
    throw new Error(
      `packaging/licenses/bun.md is not from Bun ${revision}; vendor its LICENSE.md from that commit`,
    );
  }
  return normalize(body.join("\n"));
}

function section(title: string, license: string, body: string): string {
  return `${RULE}\n${title}\nLicense: ${license}\n${RULE}\n\n${body}\n`;
}

function render(packages: readonly Package[], bun: string, projectLicense: string): string {
  const notice = normalize(readFileSync(join(ROOT, "NOTICE"), "utf8"));
  const parts = [
    `${notice}\n\n${NAME} is licensed under ${projectLicense}. It includes the software below,\nunder the licenses that follow.\n`,
    ...packages.map((pkg) =>
      section(
        `${pkg.name} ${pkg.version}`,
        pkg.license,
        pkg.texts.length > 0
          ? pkg.texts.join("\n\n")
          : `This package ships no license file. Its package.json declares ${pkg.license}.`,
      ),
    ),
    section(
      `Bun ${BUN_VERSION}, the runtime the standalone ${NAME} binary embeds`,
      "MIT, with the statically linked libraries below under their own licenses",
      bun,
    ),
  ];
  return parts.join("\n");
}

if (process.argv[1]?.endsWith("generate.ts") === true) {
  const check = process.argv.includes("--check");
  const packages = shippedPackages();
  const refused = packages.filter((pkg) => !allowed(pkg.license));
  for (const pkg of refused) {
    process.stderr.write(`${pkg.name} ${pkg.version} is ${pkg.license}, which is not allowed\n`);
  }
  const { license } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    license: string;
  };
  const text = render(packages, bunLicense(readFileSync(BUN_LICENSE, "utf8")), license);
  if (check) {
    const stale = readFileSync(NOTICES_FILE, "utf8") !== text;
    if (stale) process.stderr.write("THIRD_PARTY_NOTICES.txt is stale; run `pnpm run notices`\n");
    if (stale || refused.length > 0) process.exit(1);
    process.stdout.write(`THIRD_PARTY_NOTICES.txt is current (${packages.length} packages)\n`);
  } else {
    if (refused.length > 0) process.exit(1);
    writeFileSync(NOTICES_FILE, text);
    process.stdout.write(`wrote THIRD_PARTY_NOTICES.txt (${packages.length} packages)\n`);
  }
}
