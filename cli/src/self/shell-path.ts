import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { envName, setting } from "#core/env.ts";
import { writeAtomic } from "#core/fs/atomic.ts";
import { isMissing, userHome } from "#core/fs/path.ts";
import { canonical } from "#core/fs/realpath.ts";
import { executableFile, NAME } from "#core/product.ts";
import { binDir, shimPath } from "#core/release/layout.ts";
import { ensureHome, toolHome } from "#core/store/paths.ts";
import { addToUserPath, removeFromUserPath, USER_PATH, userPathHas } from "./windows-path.ts";

const WINDOWS = process.platform === "win32";

export interface PathChange {
  /** Startup files that now source the env file, or the Windows user environment. */
  added: string[];
  /** Startup files that could not be written. */
  failed: string[];
}

/** `$HOME`-relative where possible, so the line survives a renamed home; aireg's home is a real path. */
function spelled(path: string, env: NodeJS.ProcessEnv): string {
  for (const root of new Set([userHome(env), canonical(userHome(env))])) {
    if (path.startsWith(`${root}${sep}`)) return `$HOME${path.slice(root.length)}`;
  }
  return path;
}

/** Characters a quoted startup-file line would expand or end on. */
const UNSAFE = /["'`$\\\n]/;

/** What `aireg` resolves to on this PATH, as `command -v` would find it. */
export function resolvedOnPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, executableFile());
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Absent or not executable.
    }
  }
  return undefined;
}

export function isOurs(
  resolved: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolved !== undefined && canonical(resolved) === canonical(shimPath(env));
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    // One that cannot be read, such as a root-owned file, is one `addToPath` could not have edited.
    return undefined;
  }
}

async function appendOnce(file: string, line: string): Promise<"added" | "present" | "failed"> {
  try {
    const text = await readFile(file, "utf8").catch((error: unknown) => {
      if (isMissing(error)) return "";
      throw error;
    });
    if (text.includes(line)) return "present";
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${text !== "" && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
    return "added";
  } catch {
    return "failed";
  }
}

function sourceLine(env: NodeJS.ProcessEnv): string {
  return `. "${spelled(toolHome(env), env)}/env"`;
}

const BASH_FILES = [".bash_profile", ".bash_login", ".bashrc"];

/** A ZDOTDIR set inside ~/.zshenv is unknown to a new terminal until that file runs. */
function zshenvFiles(env: NodeJS.ProcessEnv): string[] {
  const root = userHome(env);
  const zdot = env.ZDOTDIR?.trim() || root;
  return zdot === root ? [join(root, ".zshenv")] : [join(root, ".zshenv"), join(zdot, ".zshenv")];
}

function fishDir(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CONFIG_HOME?.trim() || join(userHome(env), ".config"), "fish");
}

function fishFile(env: NodeJS.ProcessEnv): string {
  return join(fishDir(env), "conf.d", `${NAME}.fish`);
}

/**
 * One env file every shell's startup file sources, guarded so re-sourcing never stacks PATH.
 * zsh gets .zshenv because agents run non-interactive `zsh -c` shells, which skip .zshrc.
 */
export async function addToPath(env: NodeJS.ProcessEnv = process.env): Promise<PathChange> {
  if (WINDOWS) {
    ensureHome(env);
    try {
      const outcome = await addToUserPath(binDir(env), env);
      return { added: outcome === "added" ? [USER_PATH] : [], failed: [] };
    } catch {
      return { added: [], failed: [USER_PATH] };
    }
  }
  const root = userHome(env);
  const aireg = toolHome(env);
  if (UNSAFE.test(aireg)) {
    throw new Error(`The aireg folder ${aireg} cannot be written into a shell startup file.`);
  }
  ensureHome(env);
  const bin = spelled(binDir(env), env);
  // Only a home the user moved needs exporting; the default is what the shim assumes.
  const moved = setting("HOME", env) !== undefined;
  const exported = moved ? `export ${envName("HOME")}="${spelled(aireg, env)}"\n` : "";
  await writeAtomic(
    join(aireg, "env"),
    `${exported}case ":\${PATH}:" in\n  *:"${bin}":*) ;;\n  *) export PATH="${bin}:$PATH" ;;\nesac\n`,
  );
  const line = sourceLine(env);

  const shell = basename(env.SHELL ?? "sh");
  const files = [join(root, ".profile")];
  for (const name of BASH_FILES) {
    if (existsSync(join(root, name))) files.push(join(root, name));
  }
  const zdot = env.ZDOTDIR?.trim() || root;
  if (shell === "zsh" || existsSync(join(zdot, ".zshrc")) || existsSync(join(zdot, ".zshenv"))) {
    files.push(...zshenvFiles(env));
  }

  const change: PathChange = { added: [], failed: [] };
  for (const file of files) {
    const outcome = await appendOnce(file, line);
    if (outcome !== "present") change[outcome].push(file);
  }

  if (shell === "fish" || existsSync(fishDir(env))) {
    const file = fishFile(env);
    const wanted = `if not contains -- '${binDir(env)}' $PATH; set -gx PATH '${binDir(env)}' $PATH; end\n`;
    // Unreadable reads as out of date; the write below then reports the file as failed.
    const current = await readFile(file, "utf8").catch(() => undefined);
    if (current !== wanted) {
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, wanted);
        change.added.push(file);
      } catch {
        change.failed.push(file);
      }
    }
  }
  return change;
}

/** Startup files `addToPath` may have written, which hold its line or its fish file now. */
export async function onPathIn(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  if (WINDOWS) return (await userPathHas(binDir(env), env)) ? [USER_PATH] : [];
  const line = sourceLine(env);
  const root = userHome(env);
  const found: string[] = [];
  for (const file of [
    join(root, ".profile"),
    ...BASH_FILES.map((name) => join(root, name)),
    ...zshenvFiles(env),
  ]) {
    const text = readText(file);
    if (text?.split("\n").includes(line)) found.push(file);
  }
  if (existsSync(fishFile(env))) found.push(fishFile(env));
  return found;
}

export interface PathRemoval {
  /** Startup files that no longer put aireg on PATH. */
  removed: string[];
  /** Startup files that could not be written. */
  failed: string[];
}

/** Undoes `addToPath` in every file it may have written, not only those it would write today. */
export async function removeFromPath(env: NodeJS.ProcessEnv = process.env): Promise<PathRemoval> {
  const change: PathRemoval = { removed: [], failed: [] };
  if (WINDOWS) {
    try {
      if (await removeFromUserPath(binDir(env), env)) change.removed.push(USER_PATH);
    } catch {
      change.failed.push(USER_PATH);
    }
    return change;
  }
  const line = sourceLine(env);
  for (const file of await onPathIn(env)) {
    try {
      if (file === fishFile(env)) {
        await rm(file, { force: true });
      } else {
        const text = await readFile(file, "utf8");
        // Written in place, not renamed over, so a startup file that is a symlink stays one.
        await writeFile(
          file,
          text
            .split("\n")
            .filter((each) => each !== line)
            .join("\n"),
        );
      }
      change.removed.push(file);
    } catch {
      change.failed.push(file);
    }
  }
  return change;
}

/** What makes `aireg` available in the shell that ran the installer, when one command can. */
export function restartCommand(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (WINDOWS) return undefined;
  const shell = basename(env.SHELL ?? "sh");
  if (shell === "zsh" || shell === "fish") return `exec ${shell}`;
  if (["bash", "sh", "dash", "ksh"].includes(shell)) return sourceLine(env);
  return undefined;
}
