import { messageOf } from "#adapter/errors.ts";
import { list, plural, quoted } from "#adapter/text.ts";
import { actionOf, type CommandContext } from "#cli/commands/command.ts";
import { parse } from "#cli/options/parse.ts";
import { defaultIo } from "#cli/prompt/ask.ts";
import { cancel, interaction, interactive, silence } from "#cli/prompt/interaction.ts";
import { canceled } from "#cli/prompt/model.ts";
import { confirm } from "#cli/prompt/select.ts";
import { note } from "#cli/prompt/spinner.ts";
import { underHome } from "#cli/render/home.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { pad } from "#core/term/format.ts";
import type { Styler } from "#core/term/printer.ts";
import { VERSION } from "#core/version.ts";
import { autostartState, disableAutostart } from "#daemon/autostart/index.ts";
import { probeDaemon, stopDaemon } from "#daemon/process/lifecycle.ts";
import { removeFromPath } from "#self/shell-path.ts";
import { deleteFolders, type Footprint, footprint, unlinkUserScope } from "#self/uninstall.ts";
import { SELF_COMMAND } from "./spec.ts";

/** Everything aireg put on this machine outside projects. */
interface Found extends Footprint {
  daemon: boolean;
  autostart: boolean;
}

export async function survey(env: NodeJS.ProcessEnv = process.env): Promise<Found> {
  return {
    daemon: (await probeDaemon(VERSION)).status !== "down",
    autostart: (await autostartState())?.registered === true,
    ...(await footprint(env)),
  };
}

/** Turns autostart off, which stops a managed daemon, then stops one started by hand. */
export async function stopEverything(): Promise<{ autostart: boolean }> {
  const change = await disableAutostart();
  await stopDaemon();
  return { autostart: change?.changed === true };
}

export async function run(context: CommandContext): Promise<void> {
  const { common, positionals } = parse(context.argv, actionOf(SELF_COMMAND, "uninstall"));
  if (positionals.length > 0) {
    throw new AiregError(
      `\`aireg self uninstall\` takes no argument, not ${quoted(positionals[0] as string)}.`,
      {
        code: ErrorCode.Usage,
        hint: "Run `aireg self uninstall --dry-run` to see what it removes.",
      },
    );
  }
  const { printer } = context;
  const found = await survey();

  if (common.dryRun) {
    if (printer.format === "json") {
      printer.json({ ok: true, data: { action: "would-uninstall", dryRun: true, ...found } });
      return;
    }
    printer.info("Would uninstall aireg:");
    for (const line of planLines(found, printer.style)) printer.info(`  ${line}`);
    return;
  }

  if (!common.yes) {
    const step = interaction(printer, defaultIo(), false);
    if (!interactive(step)) {
      throw new AiregError("Uninstalling aireg needs confirmation.", {
        code: ErrorCode.Usage,
        hint: `Pass -y, or --dry-run to see what it removes (${silence(step)}).`,
      });
    }
    note(step.io, printer.errStyle, "Uninstall aireg", planLines(found, printer.errStyle));
    const yes = await confirm(
      { message: "Uninstall aireg?", style: printer.errStyle, initial: false },
      step.io,
    );
    if (canceled(yes) || !yes) {
      cancel(step);
      return;
    }
  }

  let stopped: { autostart: boolean };
  try {
    stopped = await stopEverything();
  } catch (error) {
    throw new AiregError(`Could not stop the daemon: ${messageOf(error)}`, {
      cause: error,
      hint: "Nothing was removed. Run `aireg daemon stop`, then `aireg self uninstall` again.",
    });
  }
  let links: string[];
  try {
    links = await unlinkUserScope();
  } catch (error) {
    throw new AiregError(`Could not remove your user scope's links: ${messageOf(error)}`, {
      cause: error,
      hint: "Only the daemon was stopped. Fix the cause, then run `aireg self uninstall` again.",
    });
  }
  const path = await removeFromPath();
  const folders = await deleteFolders();
  // Only what was on is reported as turned off.
  const done = {
    daemon: found.daemon,
    autostart: found.autostart && stopped.autostart,
    links,
    startupFiles: path.removed,
    folders: folders.deleted,
    kept: found.kept,
  };
  const failed = [...path.failed, ...folders.failed];

  if (failed.length > 0) {
    throw new AiregError(`Could not remove ${list(failed.map(underHome))}.`, {
      hint: "Everything else was removed. Delete these by hand.",
    });
  }
  if (printer.format === "json") {
    printer.json({ ok: true, data: { action: "uninstalled", dryRun: false, ...done } });
    return;
  }
  report(context, done);
}

function planLines(found: Found, style: Styler): string[] {
  const rows: [string, string[]][] = [];
  const daemon = [found.daemon ? "stop it" : "", found.autostart ? "turn autostart off" : ""];
  if (found.daemon || found.autostart) rows.push(["daemon", [daemon.filter(Boolean).join(", ")]]);
  rows.push(["unlink", found.links.map(underHome)]);
  rows.push(["PATH", found.startupFiles.map(underHome)]);
  rows.push(["delete", found.folders.map(underHome)]);
  rows.push(["keep", [...found.kept.map(underHome), "each project's .registry/ folder"]]);
  return rows.flatMap(([label, values]) =>
    values.map((value, index) => `${style.dim(pad(index === 0 ? label : "", 8))}${value}`),
  );
}

function report(context: CommandContext, done: Found): void {
  const { printer } = context;
  if (done.daemon && done.autostart)
    printer.success("Stopped the daemon and turned off autostart.");
  else if (done.daemon) printer.success("Stopped the daemon.");
  else if (done.autostart) printer.success("Turned off autostart.");
  if (done.links.length > 0) {
    printer.success(`Removed ${plural(done.links.length, "link")} from target folders.`);
    for (const link of done.links) printer.info(`  ${underHome(link)}`);
  }
  if (done.startupFiles.length > 0) {
    printer.success(`Removed aireg from PATH in ${list(done.startupFiles.map(underHome))}.`);
  }
  if (done.folders.length > 0) printer.success(`Deleted ${list(done.folders.map(underHome))}.`);
  for (const path of done.kept) {
    printer.info(`Kept ${underHome(path)}, since aireg's installer did not put it there.`);
  }
  printer.success("Uninstalled aireg.");
  printer.info(
    done.startupFiles.length > 0
      ? "Projects keep their .registry/ folders. Open a new terminal to update PATH."
      : "Projects keep their .registry/ folders.",
  );
}
