import { join } from "node:path";
import { plural, quoted } from "#adapter/text.ts";
import { initAdapter, initData, printInit } from "#cli/commands/adapter/init.ts";
import type { AdapterInstall, AdapterList, AdapterRemove } from "#cli/commands/adapter/result.ts";
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
import { loadDeclaredKinds } from "#core/host/kinds.ts";
import { withReleaseHint } from "#core/release/errors.ts";
import { runningEntry } from "#core/release/launch.ts";
import { releaseStamp } from "#core/release/stamp.ts";
import { toolHome } from "#core/store/paths.ts";
import type { Printer } from "#core/term/printer.ts";
import { table } from "#core/term/table.ts";
import { VERSION } from "#core/version.ts";
import { recycleDaemon } from "#daemon/process/lifecycle.ts";
import type { CommandContext } from "./command.ts";
import { action, defineCommand, STREAMED } from "./define.ts";

interface Options {
  argument: string | undefined;
  dryRun: boolean;
  force: boolean;
  yes: boolean;
  dir: string | undefined;
}

export const { run } = defineCommand<Options>({
  spec: ADAPTER_COMMAND,
  parse(argv) {
    const { common, own, positionals } = parse<{ dir?: string }>(argv, ADAPTER_COMMAND);
    const [verb = "list", argument] = positionals;
    const { dryRun, force, yes } = common;
    return { action: verb, options: { argument, dryRun, force, yes, dir: own.dir } };
  },
  actions: {
    init: action({
      run: ({ argument, force, dryRun, dir }, context) =>
        initAdapter(context.cwd, argument, { force, dryRun, dir }),
      text: printInit,
      data: initData,
    }),
    list: action({ run: () => verified(list()), text: printList }),
    install: action({
      run: (options, context) => verified(install(context, options)),
      text: printInstall,
    }),
    remove: action({
      run: ({ argument, dryRun }) => verified(remove(argument, dryRun)),
      text: printRemove,
    }),
  },
});

async function list(): Promise<AdapterList> {
  const adapters = (await readConfig()).adapters;
  return { adapters: Object.entries(adapters).map(([id, specifier]) => ({ id, specifier })) };
}

/** Installed adapters live at `adapters/<id>/<version>/`. */
const VERSIONED = /\/(\d+\.\d+\.\d+[^/]*)\//;

function printList({ adapters: rows }: AdapterList, printer: Printer): void {
  if (rows.length === 0) {
    printer.info("No adapters installed from the release server. Built-in adapters still load.");
    return;
  }
  printer.info(printer.style.bold(`${plural(rows.length, "adapter")} installed`));
  table(
    printer,
    [
      { header: "adapter", value: (row: (typeof rows)[number]) => row.id },
      {
        header: "version",
        value: (row: (typeof rows)[number]) => VERSIONED.exec(row.specifier)?.[1] ?? "",
        optional: true,
      },
      {
        header: "module",
        value: (row: (typeof rows)[number]) => printer.style.dim(row.specifier),
      },
    ],
    rows,
  );
}

async function verified<R>(work: Promise<R>): Promise<R> {
  try {
    return await work;
  } catch (error) {
    throw withReleaseHint(
      error,
      "A released aireg checks each adapter against its release server's signing keys.",
    );
  }
}

async function install(
  context: CommandContext,
  { argument: raw, dryRun, force, yes }: Options,
): Promise<AdapterInstall | typeof STREAMED> {
  if (raw === undefined) {
    throw needsInput(
      "adapter install",
      "an adapter id",
      "Name the adapter: `aireg adapter install acme`, or `aireg adapter install acme@1.4.0` for one version.",
    );
  }
  const want = parseWant(raw);
  if (!dryRun && !yes && !isTrusted(want.id) && !(await consents(context, want.id))) {
    return STREAMED;
  }
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
  const { id, version } = release;
  if (dryRun) {
    return {
      dryRun,
      action: present ? "already-installed" : "would-install",
      id,
      version,
      specifier,
    };
  }
  if (present && !force) return { dryRun, action: "already-installed", id, version, specifier };
  const bytes = await downloadAdapter(release);
  await writeInstalled(release.id, release.version, bytes);
  // Said now, so a declaration aireg refuses is not first heard of in another command.
  for (const warning of await loadDeclaredKinds().catch(() => [])) context.printer.warning(warning);
  await recycle();
  return { dryRun, action: "installed", id, version, specifier };
}

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

function printInstall(result: AdapterInstall, printer: Printer): void {
  if (result.action === "already-installed") {
    printer.info(`${result.id} ${result.version} is already installed.`);
    return;
  }
  if (result.action === "would-install") {
    printer.info(`Would install ${result.id} ${result.version}.`);
    return;
  }
  printer.success(`Installed ${result.id} ${result.version}.`);
  printer.note("path", result.specifier);
}

async function remove(raw: string | undefined, dryRun: boolean): Promise<AdapterRemove> {
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
  if (dryRun) return { dryRun, action: "would-remove", id, specifier };
  await unpinAdapter(id);
  await recycle();
  return { dryRun, action: "removed", id, specifier };
}

function printRemove(result: AdapterRemove, printer: Printer): void {
  if (result.action === "would-remove") printer.info(`Would remove ${result.id}.`);
  else printer.success(`Removed ${result.id}.`);
}

async function recycle(): Promise<void> {
  const entry = runningEntry();
  if (entry === undefined) return;
  await recycleDaemon(entry, VERSION);
}
