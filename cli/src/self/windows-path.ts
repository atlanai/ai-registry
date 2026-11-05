import { exec } from "#core/process.ts";
import { PATH_REFRESH_VARIABLE } from "#core/product.ts";

/** Where `addToUserPath` writes, as messages name it. */
export const USER_PATH = "your Windows user environment";

const TIMEOUT_MS = 30_000;
const NO_PATH = 3;

/**
 * The raw value, so `%USERPROFILE%`-style entries stay unexpanded, and its kind, so an
 * expandable PATH stays expandable. Output is UTF-8, so a non-ASCII folder survives.
 */
const READ = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
  `if ($null -eq $key -or $null -eq $key.GetValue('Path')) { exit ${NO_PATH} }`,
  "[Console]::Out.Write([string]$key.GetValueKind('Path') + [char]10 + $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames'))",
].join("; ");

/**
 * Not `SetEnvironmentVariable('Path')`, which saves an expandable PATH as plain text. Setting
 * and clearing a throwaway variable is what makes Windows announce the change.
 */
const WRITE = [
  "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
  "$key.SetValue('Path', $env:REG_VALUE, [Microsoft.Win32.RegistryValueKind]$env:REG_KIND)",
  "$key.Close()",
  "[Environment]::SetEnvironmentVariable($env:REG_REFRESH, '1', 'User')",
  "[Environment]::SetEnvironmentVariable($env:REG_REFRESH, [NullString]::Value, 'User')",
].join("; ");

interface UserPath {
  kind: string;
  value: string;
}

/** Windows compares paths without case, and `C:\x\` names `C:\x`. */
function same(entry: string, dir: string, env: NodeJS.ProcessEnv): boolean {
  const normal = (path: string) =>
    expand(path, env)
      .replace(/[\\/]+$/, "")
      .toLowerCase();
  return normal(entry) === normal(dir);
}

/** First, as the shell profile line puts it first, so this aireg wins over an older one. */
export function withEntry(value: string, dir: string, env: NodeJS.ProcessEnv): string | undefined {
  const entries = value.split(";").filter((entry) => entry !== "");
  if (entries.some((entry) => same(entry, dir, env))) return undefined;
  return [dir, ...entries].join(";");
}

export function withoutEntry(
  value: string,
  dir: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const entries = value.split(";").filter((entry) => entry !== "");
  const kept = entries.filter((entry) => !same(entry, dir, env));
  return kept.length === entries.length ? undefined : kept.join(";");
}

export async function addToUserPath(
  dir: string,
  env: NodeJS.ProcessEnv,
): Promise<"added" | "present"> {
  const path = await readUserPath(env);
  const value = withEntry(path.value, dir, env);
  if (value === undefined) return "present";
  await writeUserPath({ ...path, value }, env);
  return "added";
}

export async function userPathHas(dir: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  // A user PATH that cannot be read is reported as one without the entry.
  const path = await readUserPath(env).catch(() => undefined);
  return path !== undefined && withEntry(path.value, dir, env) === undefined;
}

export async function removeFromUserPath(dir: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const path = await readUserPath(env);
  const value = withoutEntry(path.value, dir, env);
  if (value === undefined) return false;
  await writeUserPath({ ...path, value }, env);
  return true;
}

/** `%NAME%` as Windows expands it, with names in any case. */
function expand(entry: string, env: NodeJS.ProcessEnv): string {
  return entry.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find((each) => each.toLowerCase() === name.toLowerCase());
    return key === undefined ? whole : (env[key] ?? whole);
  });
}

async function readUserPath(env: NodeJS.ProcessEnv): Promise<UserPath> {
  const result = await runPowerShell(READ, env);
  if (result.code === NO_PATH) return { kind: "ExpandString", value: "" };
  if (result.code !== 0) throw new Error(`could not read the user PATH: ${result.stderr.trim()}`);
  const split = result.stdout.indexOf("\n");
  return { kind: result.stdout.slice(0, split).trim(), value: result.stdout.slice(split + 1) };
}

async function runPowerShell(
  script: string,
  env: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv = {},
) {
  return exec("powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    timeoutMs: TIMEOUT_MS,
    env: { ...env, ...extra },
  });
}

async function writeUserPath(path: UserPath, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runPowerShell(WRITE, env, {
    REG_VALUE: path.value,
    REG_KIND: path.kind === "String" ? "String" : "ExpandString",
    REG_REFRESH: PATH_REFRESH_VARIABLE,
  });
  if (result.code !== 0) throw new Error(`could not write the user PATH: ${result.stderr.trim()}`);
}
