import { readSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { basename } from "node:path";
import { list } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/index.ts";
import { blocker, explain } from "#cli/prompt/caller.ts";
import { canAnimate, defaultIo, quietly, spinner } from "#cli/prompt/index.ts";
import { underHome } from "#cli/render/home.ts";
import { inGitHubActions, isCI, isSet } from "#core/env.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { canonical } from "#core/fs/canonical.ts";
import { detectAll, resolveHarnesses } from "#core/harness/index.ts";
import { readManifest, writeManifest } from "#core/manifest.ts";
import { Printer } from "#core/output.ts";
import {
  OWN_SKILLS_ALIAS,
  OWN_SKILLS_NAMESPACE,
  OWN_SKILLS_PATH,
  OWN_SKILLS_SOURCE,
  ownSkillsCommand,
  ownSkillsRef,
} from "#core/own-skills.ts";
import { handOff } from "#core/process.ts";
import { binDir, shimPath } from "#core/release/layout.ts";
import { BINARY_NAME } from "#core/release/urls.ts";
import { roots } from "#core/store/paths.ts";
import { VERSION } from "#core/version.ts";
import { probeDaemon, recycleDaemon } from "#daemon/service.ts";
import { installBinaryFrom } from "#self/install.ts";
import { addToPath, isOurs, resolvedOnPath, restartCommand } from "#self/path-setup.ts";

/**
 * One line from the terminal, read with blocking reads: macOS cannot watch a reopened
 * /dev/tty for input, which is what the installer hands over. Undefined when it closes.
 */
function readLine(): string | undefined {
  const byte = Buffer.alloc(1);
  let line = "";
  for (;;) {
    let read: number;
    try {
      read = readSync(0, byte, 0, 1, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") return undefined;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      continue;
    }
    if (read === 0) return line === "" ? undefined : line;
    const char = byte.toString("utf8");
    if (char === "\n" || char === "\r") return line;
    line += char;
  }
}

/** Enter means yes; a closed terminal means no. */
function ask(question: string): boolean {
  process.stderr.write(`${question} [Y/n] `);
  const answer = readLine();
  if (answer === undefined) {
    process.stderr.write("\n");
    return false;
  }
  return ["", "y", "yes"].includes(answer.trim().toLowerCase());
}

/**
 * Runs the two documented commands at this release's tag, so the skills are an ordinary registry
 * and match this aireg. A user scope that already declares the registry is left as its owner set it.
 */
async function offerSkills(
  context: CommandContext,
  env: NodeJS.ProcessEnv,
  aireg: string,
  yes: boolean,
): Promise<void> {
  const { printer } = context;
  const user = roots("user", context.cwd);
  const manifest = await readManifest(user.manifest);
  if (manifest.registries[OWN_SKILLS_ALIAS] !== undefined) return;

  const harnesses = resolveHarnesses();
  const found = detectAll(harnesses, context.cwd).filter(
    (item) => item.detected && !item.target.shared,
  );
  const names = list(found.map((item) => item.target.displayName));
  if (found.length === 0) {
    const known = Object.values(harnesses).filter((target) => !target.shared);
    printer.info(
      `No ${list(
        known.map((target) => target.displayName),
        "or",
      )} found, so the aireg skills were not installed.`,
    );
    return;
  }

  const ref = ownSkillsRef();
  if (ref === undefined) {
    printer.info(
      "Did not install the aireg skills, because this development build has no release.",
    );
    printer.info(`Run \`${ownSkillsCommand(aireg)}\` to install them from the default branch.`);
    return;
  }
  // Agent instructions go in only on a person's yes, or on an explicit --yes.
  const prompt = blocker({ json: false, yes, isTTY: process.stdin.isTTY === true, env });
  if (prompt === undefined) {
    if (
      !ask(`Found ${names}. Install the aireg skills for ${found.length === 1 ? "it" : "them"}?`)
    ) {
      printer.info(`Run \`${ownSkillsCommand(aireg)}\` to install the aireg skills later.`);
      return;
    }
  } else if (prompt.kind !== "yes") {
    printer.info(`Did not install the aireg skills, because ${explain(prompt)}.`);
    printer.info(`Run \`${ownSkillsCommand(aireg)}\` to install them.`);
    return;
  }

  // One progress line of ours; what the commands below print is held back until it clears.
  const held: string[] = [];
  const quiet = {
    ...context,
    printer: new Printer({
      out: { write: () => {}, isTTY: false },
      err: { write: (chunk: string) => held.push(chunk), isTTY: false },
    }),
  };
  const spin = canAnimate(process.stderr) ? spinner(defaultIo(), printer.errStyle) : undefined;
  spin?.update(`Installing the aireg skills for ${names}`);
  // A user scope with no harnesses yet takes the ones found here, so later -g installs reach
  // them too; one someone already set is left, and only this entry names the harnesses.
  const wanted = found.map((item) => item.target.name);
  const defaulted = manifest.targets.length === 0;
  if (defaulted) await writeManifest(user, { ...manifest, targets: wanted });
  const sameAsScope = defaulted || wanted.join() === manifest.targets.join();
  let declared = false;
  try {
    await quietly(async () => {
      await (await import("#cli/commands/registry.ts")).run({
        ...quiet,
        argv: [
          "add",
          OWN_SKILLS_SOURCE,
          "--path",
          OWN_SKILLS_PATH,
          "--ref",
          ref,
          "--as",
          OWN_SKILLS_ALIAS,
          "-g",
        ],
      });
      declared = true;
      await (await import("#cli/commands/add.ts")).run({
        ...quiet,
        argv: [
          `${OWN_SKILLS_ALIAS}/${OWN_SKILLS_NAMESPACE}`,
          "-g",
          "--yes",
          ...(sameAsScope ? [] : ["--for", wanted.join(",")]),
        ],
      });
    });
  } catch (error) {
    // A registry declared without its skills would read as the user's choice on the next run.
    if (defaulted) {
      const now = await readManifest(user.manifest);
      await writeManifest(user, { ...now, targets: [] }).catch(() => undefined);
    }
    if (declared) {
      await (await import("#cli/commands/registry.ts"))
        .run({ ...quiet, argv: ["remove", OWN_SKILLS_ALIAS, "-g"] })
        .catch(() => undefined);
    }
    spin?.stop();
    printer.warning(`The aireg skills were not installed: ${(error as Error).message}`);
    printer.hint(`Run \`${ownSkillsCommand(aireg)}\` to install them later.`);
    return;
  }
  spin?.stop();
  printer.success(`Installed the aireg skills for ${names}.`);
  for (const chunk of held) process.stderr.write(chunk);
}

/**
 * A daemon still on the version just replaced refuses new jobs; move it to this one, as
 * self-update does. A sync in progress can outlast one stop, so it gets a few tries.
 */
async function followDaemon(bin: string, printer: Printer): Promise<void> {
  const spin = canAnimate(process.stderr) ? spinner(defaultIo(), printer.errStyle) : undefined;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const found = await probeDaemon(VERSION).catch(() => ({ status: "down" as const }));
      if (found.status !== "ready" || found.version === VERSION) return;
      spin?.update("Restarting aireg's background service");
      try {
        await recycleDaemon(bin, VERSION);
        return;
      } catch {
        // Still shutting down; ask again.
      }
    }
  } finally {
    spin?.stop();
  }
}

/**
 * Edits the startup files even when this shell already finds aireg: that PATH may be
 * left over from files since edited.
 */
async function putOnPath(
  printer: Printer,
  env: NodeJS.ProcessEnv,
): Promise<{ ready: boolean; changed: boolean }> {
  const resolved = resolvedOnPath(env);
  const ready = isOurs(resolved, env);
  if (!ready && resolved !== undefined) {
    printer.warning(`${resolved} shadows ${underHome(shimPath(env))} in this shell.`);
  }
  if (isSet("NO_MODIFY_PATH", env)) return { ready, changed: false };
  const change = await addToPath(env).catch((error: Error) => {
    printer.warning(`Could not put aireg on PATH: ${error.message}`);
    return { added: [], failed: [] };
  });
  if (change.added.length > 0) {
    printer.success(
      `Added ${underHome(binDir(env))} to PATH in ${list(change.added.map(underHome))}.`,
    );
  }
  for (const file of change.failed) {
    printer.warning(
      `Could not write ${underHome(file)}; add ${underHome(binDir(env))} to PATH there.`,
    );
  }
  return { ready, changed: change.added.length > 0 };
}

/** The last line: how to reach aireg from the shell that ran the installer. */
function sayNextStep(printer: Printer, env: NodeJS.ProcessEnv): void {
  // A Windows terminal reads the user PATH only when it starts.
  if (process.platform === "win32") {
    printer.info(
      isSet("NO_MODIFY_PATH", env)
        ? `To start using aireg, add ${binDir(env)} to your PATH.`
        : "Open a new terminal to start using aireg.",
    );
    return;
  }
  if (isSet("NO_MODIFY_PATH", env)) {
    printer.info(
      `To start using aireg, add ${underHome(binDir(env))} to your PATH: export PATH="${binDir(env)}:$PATH"`,
    );
    return;
  }
  const restart = restartCommand(env);
  printer.info(
    restart === undefined
      ? `To start using aireg, add ${underHome(binDir(env))} to your shell's PATH.`
      : `Open a new terminal or run \`${restart}\` to start using aireg.`,
  );
}

/**
 * `aireg --setup`: places this binary, puts it on PATH and offers the default registries,
 * then says how to start using aireg. The installer runs it on the binary it downloaded.
 */
export async function install(
  context: CommandContext,
  yes: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const { printer } = context;
  // Under Node, execPath is the interpreter, which must never be copied into place.
  if (basename(process.execPath).replace(/\.exe$/i, "") !== BINARY_NAME) {
    throw new AiregError("Only a standalone aireg build installs itself.", {
      code: ErrorCode.Usage,
      hint: "Run it from a release build of aireg, not from source.",
    });
  }
  const bin = await installBinaryFrom(VERSION, process.execPath, env);
  // The rest runs from the installed binary, so what it starts, such as the daemon,
  // does not point at the download that was just moved.
  if (canonical(process.execPath) !== canonical(bin)) {
    return handOff(bin, ["--setup", ...(yes ? ["--yes"] : [])], env);
  }
  printer.success(`Installed aireg ${VERSION} to ${underHome(shimPath(env))}.`);
  await followDaemon(bin, printer);

  // GitHub Actions reads later steps' PATH from this file, so the next step can run `aireg`.
  const githubPath = inGitHubActions(env) ? env.GITHUB_PATH?.trim() : undefined;
  if (githubPath) {
    try {
      await appendFile(githubPath, `${binDir(env)}\n`);
      printer.success(`Added ${binDir(env)} to PATH for the steps that follow.`);
    } catch (error) {
      printer.warning(`Could not add ${binDir(env)} to $GITHUB_PATH: ${(error as Error).message}`);
    }
    return 0;
  }

  const { ready, changed } = await putOnPath(printer, env);
  if (!isSet("NO_DEFAULT_REGISTRIES", env) && !isCI(env)) {
    // Until a new shell picks up PATH, only the full path runs.
    const aireg = ready ? "aireg" : underHome(shimPath(env));
    await offerSkills(context, env, aireg, yes).catch((error: Error) => {
      printer.warning(`The aireg skills were not installed: ${error.message}`);
      printer.hint(`Run \`${ownSkillsCommand(aireg)}\` to install them later.`);
    });
  }
  // Terminals already open read the startup files only when they start again.
  if (!ready || changed) sayNextStep(printer, env);
  return 0;
}
