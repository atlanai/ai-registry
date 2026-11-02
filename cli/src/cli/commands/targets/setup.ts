import { plural } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/index.ts";
import { underHome } from "#cli/render/home.ts";
import { readLock } from "#core/lock.ts";
import { exec, inTerminal } from "#core/process.ts";
import { roots as scopeRoots } from "#core/store/paths.ts";
import type { Target } from "#core/target/contract.ts";
import { resolveTargets, targetRoot } from "#core/target/index.ts";
import { agentStates, installedIds, setupArgv, type TargetState } from "./state.ts";

/** What setup did for one merged plugin, or left to a person. */
interface Step {
  target: string;
  registry: string;
  outcome: "installed" | "already" | "failed" | "needs-person";
  /** The command that installs it, for a person to run where setup could not ask. */
  run?: string;
}

const shellWord = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word}'`);
const shown = (argv: readonly string[]) => argv.map(shellWord).join(" ");

/** True when a person is at this terminal to answer the target's own question. */
function attended(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * Lists the folder with the target, then installs each registry's plugin it does not have yet.
 * The target shows the person the command it will run each session and asks before it runs it,
 * so with nobody at the terminal setup only says what to run.
 */
async function setUp(target: Target, state: TargetState, interactive: boolean): Promise<Step[]> {
  const setup = target.kinds.plugin?.wrapped?.setup;
  if (setup === undefined || state.plugins.length === 0) return [];
  const root = targetRoot(target, "user", process.cwd());
  const [program = "", ...args] = setupArgv(setup.add, "", root);
  const added = await exec(program, args, { timeoutMs: 120_000 });
  const steps: Step[] = [];
  const ids = added.code === 0 ? await installedIds(setup, root) : added.stderr.trim();
  for (const plugin of state.plugins) {
    const install = setupArgv(setup.install, plugin.registry, root);
    const id = setupArgv([setup.id], plugin.registry, root)[0] ?? "";
    const base = { target: target.name, registry: plugin.registry };
    if (typeof ids !== "string" && ids.has(id)) {
      steps.push({ ...base, outcome: "already" });
      continue;
    }
    if (added.code !== 0 || !interactive) {
      steps.push({
        ...base,
        outcome: added.code === 0 ? "needs-person" : "failed",
        run: shown(install),
      });
      continue;
    }
    const [command = "", ...rest] = install;
    const code = await inTerminal(command, rest);
    steps.push({ ...base, outcome: code === 0 ? "installed" : "failed", run: shown(install) });
  }
  return steps;
}

function report(context: CommandContext, states: readonly TargetState[]): void {
  const { printer } = context;
  if (states.length === 0) {
    printer.info("No coding agent loads anything from your user scope yet.");
    printer.hint("Run `aireg add -g <registry>` to install a registry's artifacts.");
    return;
  }
  for (const state of states) {
    printer.info(`${state.displayName}: ${plural(state.artifacts, "artifact")} linked`);
    for (const plugin of state.plugins) {
      const loaded =
        plugin.installed === undefined
          ? "not known to be installed"
          : plugin.installed
            ? "installed"
            : "not installed";
      const parts = `${plural(plugin.skills, "skill")}, ${plural(plugin.agents, "agent")}`;
      printer.info(`  ${plugin.registry}: ${parts}, ${loaded}, in ${underHome(plugin.folder)}`);
    }
    if (state.unknown !== undefined) printer.note("why", state.unknown);
    for (const path of state.earlier) printer.warning(`An earlier aireg left ${underHome(path)}.`);
    if (state.earlier.length > 0) printer.hint("Run `aireg sync -g` to move it.");
  }
}

function reportSteps(context: CommandContext, steps: readonly Step[]): void {
  for (const step of steps) {
    if (step.outcome === "installed") context.printer.success(`Installed ${step.registry}.`);
    if (step.outcome === "failed") {
      context.printer.warning(`Could not install ${step.registry}.`);
    }
    if (step.outcome === "needs-person" || step.outcome === "failed") {
      context.printer.hint(`Run \`${step.run}\` in a terminal to review and install it.`);
    }
  }
}

/** `aireg targets setup`: each coding agent loads your registries as plugins it installs. */
export async function setup(context: CommandContext, statusOnly: boolean): Promise<void> {
  const roots = scopeRoots("user", context.cwd);
  const targetTable = resolveTargets();
  const lock = await readLock(roots);
  const steps: Step[] = [];
  if (!statusOnly) {
    const interactive = attended() && context.printer.format !== "json";
    for (const state of await agentStates(targetTable, lock, roots)) {
      const target = targetTable[state.target];
      if (target !== undefined) steps.push(...(await setUp(target, state, interactive)));
    }
  }
  const states = await agentStates(targetTable, lock, roots);
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { targets: states, ...(statusOnly ? {} : { steps }) } });
    return;
  }
  reportSteps(context, steps);
  report(context, states);
}
