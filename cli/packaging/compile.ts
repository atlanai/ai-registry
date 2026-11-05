import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { formatVersion, parseVersion, type Version } from "#adapter/semver.ts";
import { NAME, PUBLISHER } from "#core/product.ts";
import { defines } from "./defines.ts";
import { BUN_VERSION, hostTarget, type Target } from "./targets.ts";

/** Bundled by Bun, not by tsup: the compiled binary has no `dist/` to load. Bun reads `/` on Windows too. */
const ENTRY = "src/main.ts";

export interface CompileOptions {
  readonly target: Target;
  readonly version: string;
  /** Release origin, stamped in. Empty builds a binary that does not update itself. */
  readonly origin: string;
  /** Encoded trusted Ed25519 keyring, stamped in. Empty fails signing closed. */
  readonly keyring: string;
  /** The source commit, reported by `--version --json`. */
  readonly commit?: string;
  readonly outFile: string;
}

/**
 * What Windows shows in a binary's properties and in Task Manager. Bun sets these only when
 * compiling on Windows, which is where the release builds each Windows target.
 */
function windowsResources(version: Version): string[] {
  return [
    `--windows-title=${NAME}`,
    `--windows-description=${NAME}`,
    `--windows-publisher=${PUBLISHER}`,
    `--windows-version=${version.major}.${version.minor}.${version.patch}.0`,
    `--windows-copyright=Copyright ${PUBLISHER}`,
  ];
}

/** `--bytecode` and `--minify` are absent on purpose; compile.test.ts says why. */
export function compileArgs(options: CompileOptions, executable?: string): string[] {
  const version = parseVersion(options.version);
  if (version === undefined || formatVersion(version) !== options.version) {
    throw new Error(`compile version must be exact SemVer (got ${options.version})`);
  }
  // Bun otherwise reads .env and bunfig.toml from the folder aireg runs in. Stamps are build
  // inputs, never configuration: a redirectable origin makes the signature check decorative.
  return [
    "build",
    "--compile",
    ...(executable === undefined ? [] : [`--compile-executable-path=${executable}`]),
    `--target=${options.target.bunTarget}`,
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    ...Object.entries(
      defines({
        version: options.version,
        origin: options.origin,
        keyring: options.keyring,
        commit: options.commit ?? "",
      }),
    ).flatMap(([name, value]) => ["--define", `${name}=${value}`]),
    ...(options.target.os === "windows" ? windowsResources(version) : []),
    `--outfile=${options.outFile}`,
    ENTRY,
  ];
}

export function compile(options: CompileOptions, cwd: string, bun = "bun"): string {
  if (hostTarget()?.platform !== options.target.platform) {
    throw new Error("release builds require the target's native runner");
  }
  const found = execFileSync(bun, ["--revision"], { encoding: "utf8" }).trim();
  if (found !== BUN_VERSION) {
    throw new Error(`release builds pin Bun ${BUN_VERSION}; this is ${found}`);
  }
  const executable = execFileSync(bun, ["-p", "process.execPath"], { encoding: "utf8" }).trim();
  mkdirSync(dirname(options.outFile), { recursive: true });
  execFileSync(bun, compileArgs(options, executable), { cwd, stdio: "inherit" });
  return options.outFile;
}
