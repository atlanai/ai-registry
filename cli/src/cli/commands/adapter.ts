import { join } from "node:path";
import { plural, quoted } from "#adapter/text.ts";
import { initAdapter } from "#cli/commands/adapter/init.ts";
import { ADAPTER_COMMAND } from "#cli/commands/adapter/spec.ts";
import { needsInput, parse } from "#cli/options/parse.ts";
import { defaultIo } from "#cli/prompt/ask.ts";
import { cancel, interaction, interactive } from "#cli/prompt/interaction.ts";
import { canceled } from "#cli/prompt/model.ts";
import { confirm } from "#cli/prompt/select.ts";
import { underHome } from "#cli/render/home.ts";
import { downloadAdapter, resolveAdapter } from "#core/adapter/installed/fetch.ts";
import { adapterSpecifier, unpinAdapter, writeInstalled } from "#core/adapter/installed/store.ts";
import { isTrusted, parseAdapterId, parseWant } from "#core/adapter/installed/want.ts";
import { configPath, readConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { exists } from "#core/fs/tree.ts";
import { withReleaseHint } from "#core/release/errors.ts";
import { runningEntry } from "#core/release/launch.ts";
import { releaseStamp } from "#core/release/stamp.ts";
import { toolHome } from "#core/store/paths.ts";
import { table } from "#core/term/table.ts";
import { VERSION } from "#core/version.ts";
import { recycleDaemon } from "#daemon/process/lifecycle.ts";
import { type CommandContext, runAction } from "./command.ts";

export async function run(context: CommandContext): Promise<void> {
  const spec = ADAPTER_COMMAND;
  const { common, own, positionals } = parse<{ dir?: string }>(context.argv, spec);
  const [action = "list", argument] = positionals;
  return runAction(spec, action, {
    init: () => initAdapter(context, argument, common, own),
    list: () => verified(list(context)),
    install: () => verified(install(context, argument, common)),
    remove: () => verified(remove(context, argument, common.dryRun)),
  });
}

async function list(context: CommandContext): Promise<void> {
  const adapters = (await readConfig()).adapters;
  const rows = Object.entries(adapters).map(([id, specifier]) => ({ id, specifier }));
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data: { adapters: rows } });
    return;
  }
  if (rows.length === 0) {
    context.printer.info(
      "No adapters installed from the release server. Built-in adapters still load.",
    );
    return;
  }
  context.printer.info(context.printer.style.bold(`${plural(rows.length, "adapter")} installed`));
  table(
    context.printer,
    [
      { header: "adapter", value: (row: (typeof rows)[number]) => row.id },
      {
        header: "version",
        value: (row: (typeof rows)[number]) => VERSIONED.exec(row.specifier)?.[1] ?? "",
        optional: true,
      },
      {
        header: "module",
        value: (row: (typeof rows)[number]) => context.printer.style.dim(row.specifier),
      },
    ],
    rows,
  );
}

/** A failure the release server's checks raised, named as one rather than as a crash. */
async function verified(work: Promise<void>): Promise<void> {
  try {
    await work;
  } catch (error) {
    throw withReleaseHint(
      error,
      "A released aireg checks each adapter against its release server's signing keys.",
    );
  }
}

async function install(
  context: CommandContext,
  raw: string | undefined,
  { dryRun, force, yes }: { dryRun: boolean; force: boolean; yes: boolean },
): Promise<void> {
  if (raw === undefined) {
    throw needsInput(
      "adapter install",
      "an adapter id",
      "Name the adapter: `aireg adapter install acme`, or `aireg adapter install acme@1.4.0` for one version.",
    );
  }
  const want = parseWant(raw);
  if (!dryRun && !yes && !isTrusted(want.id) && !(await consents(context, want.id))) return;
  const stamp = releaseStamp();
  if (stamp === undefined) {
    throw new AiregError(
      "This build of aireg has no release server, so it cannot verify an adapter.",
      {
        code: ErrorCode.Unavailable,
        hint: `Use a released build, or set \`adapters:\` in ${underHome(configPath())} to a local module.`,
      },
    );
  }
  const release = await resolveAdapter(want, stamp);
  const specifier = adapterSpecifier(release.id, release.version);
  const current = (await readConfig()).adapters[release.id];
  const present = current === specifier && (await exists(join(toolHome(), specifier)));
  if (dryRun) {
    report(context, {
      dryRun,
      action: present ? "already-installed" : "would-install",
      id: release.id,
      version: release.version,
      specifier,
    });
    return;
  }
  if (present && !force) {
    report(context, {
      dryRun,
      action: "already-installed",
      id: release.id,
      version: release.version,
      specifier,
    });
    return;
  }
  const bytes = await downloadAdapter(release);
  await writeInstalled(release.id, release.version, bytes);
  await recycle();
  report(context, {
    dryRun,
    action: "installed",
    id: release.id,
    version: release.version,
    specifier,
  });
}

/** Installed adapters live at `adapters/<id>/<version>/`. */
const VERSIONED = /\/(\d+\.\d+\.\d+[^/]*)\//;

/** An adapter runs inside aireg with your access, so one it does not trust needs a yes. */
async function consents(context: CommandContext, id: string): Promise<boolean> {
  const step = interaction(context.printer, defaultIo(), false);
  if (!interactive(step)) {
    throw new AiregError(`${quoted(id)} is not a trusted adapter.`, {
      code: ErrorCode.Usage,
      hint: "Pass `--yes` to install an adapter that is not trusted.",
    });
  }
  const yes = await confirm(
    {
      message: `${quoted(id)} is not a trusted adapter. Install it anyway?`,
      style: context.printer.errStyle,
      initial: false,
    },
    step.io,
  );
  if (canceled(yes) || !yes) {
    cancel(step);
    return false;
  }
  return true;
}

function report(
  context: CommandContext,
  data: {
    dryRun: boolean;
    action: string;
    id: string;
    specifier: string;
    version?: string | undefined;
  },
): void {
  if (context.printer.format === "json") {
    context.printer.json({ ok: true, data });
    return;
  }
  if (data.action === "already-installed") {
    context.printer.info(`${data.id} ${data.version} is already installed.`);
    return;
  }
  if (data.action === "would-install") {
    context.printer.info(`Would install ${data.id} ${data.version}.`);
    return;
  }
  if (data.action === "would-remove") {
    context.printer.info(`Would remove ${data.id}.`);
    return;
  }
  if (data.action === "removed") {
    context.printer.success(`Removed ${data.id}.`);
    return;
  }
  context.printer.success(`Installed ${data.id} ${data.version}.`);
  context.printer.note("path", data.specifier);
}

async function remove(
  context: CommandContext,
  raw: string | undefined,
  dryRun: boolean,
): Promise<void> {
  if (raw === undefined) {
    throw needsInput(
      "adapter remove",
      "an adapter id",
      "Name the adapter: `aireg adapter remove <id>`.",
    );
  }
  const id = parseAdapterId(raw);
  const specifier = (await readConfig()).adapters[id];
  if (specifier === undefined) {
    throw new AiregError(`No installed adapter named ${quoted(id)}.`, {
      code: ErrorCode.NotFound,
      hint: "Built-in adapters need no install. Run `aireg adapter list` to see the installed ones.",
    });
  }
  if (dryRun) {
    report(context, { dryRun, action: "would-remove", id, specifier });
    return;
  }
  await unpinAdapter(id);
  await recycle();
  report(context, { dryRun, action: "removed", id, specifier });
}

async function recycle(): Promise<void> {
  const entry = runningEntry();
  if (entry === undefined) return;
  await recycleDaemon(entry, VERSION);
}
