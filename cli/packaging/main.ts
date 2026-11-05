import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXECUTABLE } from "#adapter/files.ts";
import { envName, type Setting, setting } from "#core/env.ts";
import { isChannel } from "#core/release/origin.ts";
import { renderInstaller, renderWindowsInstaller } from "#packaging/installer/render.ts";
import { compile } from "./compile.ts";
import { privateKeyFromSeed, signManifest, verifySigned } from "./manifest.ts";
import { hostTarget, TARGETS, type Target } from "./targets.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "dist-standalone");
const BIN = join(OUT, "bin");

function required(name: Setting): string {
  const value = setting(name);
  if (value === undefined) throw new Error(`${envName(name)} is required`);
  return value;
}

/** The CI secret, not an aireg setting: the publish step passes it to this process only. */
function signingSeed(): string {
  const value = process.env.RELEASE_ED25519_PRIVATE_KEY?.trim();
  if (value === undefined || value === "")
    throw new Error("RELEASE_ED25519_PRIVATE_KEY is required");
  return value;
}

/** Release targets use native runners; none named selects the host's own pair. */
function wanted(names: readonly string[]): Target[] {
  if (names.length === 0) {
    const host = hostTarget();
    if (host === undefined) {
      throw new Error(`no release target matches ${process.platform}/${process.arch}; name one`);
    }
    return [host];
  }
  return names.map((name) => {
    const target = TARGETS.find((entry) => entry.filename === name);
    if (target === undefined) {
      const known = TARGETS.map((entry) => entry.filename).join(", ");
      throw new Error(`unknown target ${name}; expected one of ${known}`);
    }
    return target;
  });
}

function compileTargets(args: readonly string[]): void {
  const version = required("RELEASE_VERSION");
  for (const target of wanted(args)) {
    const written = compile(
      {
        target,
        version,
        origin: setting("RELEASE_ORIGIN") ?? "",
        keyring: setting("RELEASE_KEYRING") ?? "",
        commit: setting("RELEASE_COMMIT") ?? "",
        outFile: join(BIN, target.filename),
      },
      ROOT,
    );
    process.stdout.write(`compiled ${written}\n`);
  }
}

function writeInstallers(): void {
  const config = {
    version: required("RELEASE_VERSION"),
    origin: required("RELEASE_ORIGIN"),
    binaryDir: BIN,
  };
  mkdirSync(OUT, { recursive: true });
  const sh = join(OUT, "install.sh");
  writeFileSync(sh, renderInstaller(config), { mode: EXECUTABLE });
  process.stdout.write(`wrote ${sh}\n`);
  const powershell = join(OUT, "install.ps1");
  writeFileSync(powershell, renderWindowsInstaller(config));
  process.stdout.write(`wrote ${powershell}\n`);
}

/** `--name value` pairs; a repeated flag collects every value. */
function flags(args: readonly string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined || value === "") {
      throw new Error(`expected --flag value pairs, got '${flag ?? ""}'`);
    }
    found.set(flag.slice(2), [...(found.get(flag.slice(2)) ?? []), value]);
  }
  return found;
}

function one(found: Map<string, string[]>, name: string): string {
  const value = found.get(name)?.at(-1);
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

function channelOf(found: Map<string, string[]>) {
  const channel = one(found, "channel");
  if (!isChannel(channel)) throw new Error(`--channel must be a known channel, got '${channel}'`);
  return channel;
}

function signChannel(args: readonly string[]): void {
  const found = flags(args);
  const artifacts = found.get("artifact") ?? [];
  if (artifacts.length === 0) throw new Error("at least one --artifact is required");
  const output = one(found, "output");
  writeFileSync(
    output,
    signManifest({
      channel: channelOf(found),
      version: one(found, "version"),
      minimumVersion: found.get("minimum-version")?.at(-1),
      origin: one(found, "origin"),
      artifacts,
      keyId: one(found, "key-id"),
      privateKey: privateKeyFromSeed(signingSeed()),
    }),
  );
  process.stdout.write(`signed ${output} with ${one(found, "key-id")}\n`);
}

function verifyChannel(args: readonly string[]): void {
  const found = flags(args);
  const input = one(found, "input");
  const manifest = verifySigned(
    readFileSync(input, "utf8"),
    required("RELEASE_KEYRING"),
    channelOf(found),
  );
  process.stdout.write(
    `verified ${input}: ${manifest.channel} v${manifest.version}, ${manifest.artifacts.length} artifact(s)\n`,
  );
}

function main(): void {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  if (command === "compile") {
    compileTargets(args);
  } else if (command === "installer") {
    writeInstallers();
  } else if (command === "sign") {
    signChannel(args);
  } else if (command === "verify") {
    verifyChannel(args);
  } else {
    throw new Error(
      `usage: packaging/main.ts compile [target...]|installer|sign|verify (got ${command ?? "nothing"})`,
    );
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
