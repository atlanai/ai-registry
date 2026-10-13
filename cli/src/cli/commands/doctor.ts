import type { Stats } from "node:fs";
import { lstat, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advertisedCapabilities } from "#adapter/contract.ts";
import { gte } from "#adapter/semver.ts";
import { plural, sanitizeText } from "#adapter/text.ts";
import { noArguments, parse } from "#cli/options.ts";
import { underHome } from "#cli/render/home.ts";
import { loadAdapters } from "#core/adapter/registry.ts";
import { fileExposure } from "#core/credentials/store.ts";
import { ExitCode } from "#core/errors.ts";
import { WRITABLE_BY_OTHERS } from "#core/fs/mode.ts";
import { isMissing } from "#core/fs/path.ts";
import { ownSkillsCommand, ownSkillsInstalled } from "#core/own-skills.ts";
import { NAME } from "#core/product.ts";
import { type ReleaseStamp, releaseStamp } from "#core/release/stamp.ts";
import { cacheDir, credentialsPath, toolHome, userScopeDir } from "#core/store/paths.ts";
import { displayWidth, pad } from "#core/term/format.ts";
import { nodeTooOld, VERSION } from "#core/version.ts";
import { autostartState } from "#daemon/autostart/index.ts";
import { readUpdateCache, type UpdateCache } from "#self/check.ts";
import { builtin, type CommandContext } from "./index.ts";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** The one command that fixes or improves it. */
  fix?: string;
  /** Worth knowing, with nothing to do. */
  info?: boolean;
}

/** Can this machine make the links projection depends on? */
async function canLink(): Promise<Check> {
  const dir = await mkdtemp(join(tmpdir(), `${NAME}-doctor-`));
  try {
    await writeFile(join(dir, "a"), "");
    await symlink(join(dir, "a"), join(dir, "b"));
    return { name: "symlinks", ok: true, detail: "supported" };
  } catch {
    return {
      name: "symlinks",
      ok: false,
      detail: "unavailable, so artifacts are copied",
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Off is healthy; a definition that is not loaded, or that starts another install, is not. */
async function autostart(): Promise<Check> {
  const fix = "aireg daemon autostart on";
  const state = await autostartState();
  if (state === undefined) {
    return { name: "autostart", ok: true, info: true, detail: "unsupported here" };
  }
  if (!state.registered) {
    return {
      name: "autostart",
      ok: true,
      detail: "off",
      fix,
    };
  }
  if (!state.loaded)
    return { name: "autostart", ok: false, detail: "registered but not loaded", fix };
  if (!state.current) {
    return { name: "autostart", ok: false, detail: "starts a different install", fix };
  }
  return { name: "autostart", ok: true, detail: `on (${state.mechanism})` };
}

/** Stored credentials are refused while other users can write to the home holding them. */
async function home(): Promise<Check> {
  const path = toolHome();
  const shown = underHome(path);
  let mode: number;
  try {
    mode = (await stat(path)).mode;
  } catch (error) {
    if (isMissing(error)) {
      return { name: "home", ok: true, detail: `${shown}, not created yet` };
    }
    return { name: "home", ok: false, detail: `${shown} cannot be checked` };
  }
  if (process.platform !== "win32" && (mode & WRITABLE_BY_OTHERS) !== 0) {
    return {
      name: "home",
      ok: false,
      detail: `${shown} can be written by other users`,
      fix: `chmod 700 ${shown}`,
    };
  }
  return { name: "home", ok: true, detail: shown };
}

/** What every command would refuse about the file, by the store's own rule; its contents are never read. */
async function credentials(): Promise<Check> {
  const path = credentialsPath();
  const shown = underHome(path);
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return { name: "credentials", ok: true, detail: "none stored" };
    }
    return { name: "credentials", ok: false, detail: `${shown} cannot be checked` };
  }
  const exposed = fileExposure(info);
  if (exposed !== undefined) {
    return {
      name: "credentials",
      ok: false,
      detail: `${shown} ${exposed}`,
      ...(exposed === "can be read by other users" ? { fix: `chmod 600 ${shown}` } : {}),
    };
  }
  if (process.platform === "win32") return { name: "credentials", ok: true, detail: shown };
  return { name: "credentials", ok: true, detail: `${shown}, owner only` };
}

/** Where `-g` installs. */
function userScope(): Check {
  return { name: "user scope", ok: true, detail: underHome(userScopeDir()) };
}

/** The skills that teach your agents aireg; a hint, never a failure. */
async function ownSkills(cwd: string): Promise<Check> {
  const installed = await ownSkillsInstalled(cwd).catch((error: Error) => error);
  if (installed instanceof Error) {
    return { name: "aireg skills", ok: true, detail: `unknown: ${installed.message}` };
  }
  if (installed) return { name: "aireg skills", ok: true, detail: "installed" };
  return {
    name: "aireg skills",
    ok: true,
    detail: "not installed",
    fix: ownSkillsCommand(),
  };
}

function updates(stamp: ReleaseStamp | undefined, cached: UpdateCache | undefined): Check {
  if (stamp === undefined) {
    return {
      name: "updates",
      ok: true,
      info: true,
      detail: "not in this build, so update aireg the way you installed it",
    };
  }
  const channel = `${stamp.channel} channel`;
  if (cached?.latest === undefined) {
    return {
      name: "updates",
      ok: true,
      detail: `${channel}, not checked yet`,
      fix: "aireg self update --check",
    };
  }
  return gte(VERSION, cached.latest)
    ? { name: "updates", ok: true, detail: `${channel}, up to date` }
    : {
        name: "updates",
        ok: true,
        detail: `${channel}, ${cached.latest} is available`,
        fix: "aireg self update",
      };
}

async function checksFor(
  cwd: string,
  adapters: Awaited<ReturnType<typeof loadAdapters>>,
): Promise<Check[]> {
  const prerequisites: Check[] = [];
  for (const adapter of adapters.loaded) {
    for (const item of (await adapter.ready?.()) ?? []) prerequisites.push(item);
  }
  // One broken module is reported where it stands; every other check still runs.
  for (const { id, error } of adapters.broken) {
    const why = error instanceof Error ? sanitizeText(error.message) : "it did not load";
    prerequisites.push({ name: `adapter ${id}`, ok: false, detail: why });
  }
  const cached = await readUpdateCache();
  const tooOld = nodeTooOld();
  return [
    { name: "cli", ok: true, detail: VERSION },
    {
      name: "node",
      ok: tooOld === undefined,
      detail: tooOld ?? process.versions.node,
    },
    ...prerequisites,
    await canLink(),
    {
      name: "store",
      ok: true,
      detail: underHome(cacheDir()),
    },
    await autostart(),
    await home(),
    await credentials(),
    userScope(),
    await ownSkills(cwd),
    // aireg itself sends none; an installed adapter reports its own through `ready()`.
    {
      name: "telemetry",
      ok: true,
      info: true,
      detail: "none",
    },
    updates(releaseStamp(), cached),
  ];
}

export async function run(context: CommandContext): Promise<void> {
  const { positionals } = parse(context.argv, builtin("doctor"));
  noArguments(
    positionals,
    "doctor",
    "It only reads. To clear a stuck write lock, run `aireg unlock`.",
  );

  const found = await loadAdapters();
  const checks = await checksFor(context.cwd, found);
  const adapters = found.loaded.map((adapter) => ({
    id: adapter.id,
    displayName: adapter.displayName,
    capabilities: advertisedCapabilities(adapter.capabilities),
  }));
  const fatal = checks.some(
    (check) => (check.name === "git" || check.name === "node") && !check.ok,
  );
  if (fatal) context.exit = ExitCode.Error;
  if (context.printer.format === "json") {
    const problems = checks.filter((check) => !check.ok).length;
    context.printer.json({ ok: !fatal, data: { problems, checks, adapters } });
    return;
  }
  render(context, checks);
}

/** One line of versions, then a checklist: what passed, what to improve, what blocks installs. */
function render(context: CommandContext, checks: readonly Check[]): void {
  const { style } = context.printer;
  const version = (name: string) => checks.find((check) => check.name === name);
  const git = version("git");
  const node = version("node");
  const versions = [
    `aireg ${VERSION}`,
    node?.ok === true ? `Node.js ${node.detail}` : undefined,
    git?.ok === true ? `git ${/\d+(\.\d+)+/.exec(git.detail)?.[0] ?? git.detail}` : undefined,
  ];
  context.printer.info(style.bold(versions.filter(Boolean).join(" · ")));
  context.printer.info();
  const rows = checks.filter(
    (check) =>
      check.name !== "cli" && !((check.name === "git" || check.name === "node") && check.ok),
  );
  const width = Math.max(...rows.map((check) => displayWidth(check.name)));
  for (const check of rows) {
    const mark = !check.ok
      ? style.red("✗")
      : check.fix !== undefined
        ? style.yellow("!")
        : check.info === true
          ? style.dim("i")
          : style.green("✓");
    const label = pad(check.name, width);
    context.printer.info(
      `  ${mark}  ${label}  ${check.ok ? style.dim(check.detail) : check.detail}`,
    );
    // One copyable command per line, never joined with `&&`.
    for (const command of check.fix?.split(" && ") ?? []) {
      context.printer.info(`     ${pad("", width)}  ${command}`);
    }
  }
  context.printer.info();
  const failed = rows.filter((check) => !check.ok).length;
  const suggested = rows.filter((check) => check.ok && check.fix !== undefined).length;
  const more = suggested === 0 ? "" : ` ${plural(suggested, "suggestion")} above.`;
  if (failed === 0) context.printer.success(`This machine is ready.${more}`);
  else context.printer.info(`${style.red("✗")} ${plural(failed, "problem")} to fix.${more}`);
}
