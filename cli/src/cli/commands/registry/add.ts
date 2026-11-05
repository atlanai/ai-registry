import { canSignIn } from "#adapter/contract.ts";
import { isAdapterError } from "#adapter/index.ts";
import { plural, withoutCredentials } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { type Move, moveOf, recordMove, signInLeftBehind } from "#cli/commands/registry/move.ts";
import { needsInput } from "#cli/options/parse.ts";
import { noteUserScope } from "#cli/render/where.ts";
import { loadAdapter } from "#core/adapter/load.ts";
import { expandLocation, recordedLocation } from "#core/adapter/location.ts";
import { registryToken } from "#core/env.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { RegistrySource } from "#core/manifest/model.ts";
import { writeManifest } from "#core/manifest/repository.ts";
import type { Roots } from "#core/store/paths.ts";
import { type Probed, probe, sourceConfig } from "#engine/address/probe.ts";
import type { CommonOptions } from "#engine/options.ts";
import { type Loaded, load, withScope } from "#engine/scope/load.ts";
import type { Flags } from "./options.ts";
import { described } from "./shared.ts";

export async function add(
  context: CommandContext,
  input: string | undefined,
  flags: Flags,
  common: CommonOptions,
): Promise<void> {
  if (input === undefined) {
    throw needsInput(
      "registry add",
      "a registry address",
      "Name the address: `aireg registry add <address>`, such as github.com/owner/repo, a URL or a folder.",
    );
  }

  const loaded = await load(common, context.cwd, "user");

  // Reading it proves the address resolves and supplies the alias. A private one
  // cannot be read before it is declared, so an auth failure declares it anyway.
  let declared: RegistrySource;
  let alias: string;
  let label: string | undefined;
  let fromAddress = false;
  let readable = true;
  let move: Move | undefined;
  try {
    const source = await probe(input, flags, context.cwd);
    try {
      declared = {
        ...source.declared,
        location: recordedLocation(input, source.declared.location, loaded.roots),
      };
      alias = flags.as ?? source.alias;
      label = source.label;
      fromAddress = flags.as === undefined && source.named === "address";
      ({ declared, move } = await settle(context, loaded, common.dryRun, alias, declared, source));
    } finally {
      await source.close();
    }
  } catch (error) {
    if (!(error instanceof AiregError) || error.code !== ErrorCode.Unauthorized) throw error;
    // Adapters that manage credentials without a sign-in flow cannot recover after declaration.
    const failed = isAdapterError(error.cause)
      ? await loadAdapter(error.cause.adapter).catch(() => undefined)
      : undefined;
    if (failed?.credentialsHint !== undefined && !canSignIn(failed)) throw error;
    if (flags.as === undefined) {
      throw new AiregError(`Cannot read ${input} before you sign in, so it needs a name.`, {
        code: ErrorCode.Unauthorized,
        hint: `Run \`aireg registry add ${input} --as <name>\`, then \`aireg auth login <name>\`.`,
      });
    }
    declared = {
      location: recordedLocation(input, expandLocation(input, context.cwd), loaded.roots),
      adapter: flags.adapter,
      config: sourceConfig(flags),
    };
    alias = flags.as;
    readable = false;
    ({ declared, move } = await settle(context, loaded, common.dryRun, alias, declared, undefined));
  }

  const movedFrom = move === undefined ? {} : { movedFrom: move.from, kept: move.kept };
  if (context.printer.format === "json") {
    context.printer.json({
      ok: true,
      data: { ...described(alias, declared), ...movedFrom, readable, dryRun: common.dryRun },
    });
    return;
  }
  if (move !== undefined) return moved(context, loaded.roots, alias, declared, move, common.dryRun);
  if (common.dryRun) {
    context.printer.info(
      `Would add registry ${alias} at ${withoutCredentials(declared.location)}.`,
    );
    context.printer.dryRun();
    return;
  }
  context.printer.success(`Added registry ${alias} at ${withoutCredentials(declared.location)}.`);
  if (label !== undefined) context.printer.note("about", label);
  if (fromAddress) context.printer.note("named", "after its address; choose another with --as");
  noteUserScope(context.printer, common.scope, context.cwd);
  const g = loaded.roots.scope === "user" ? "-g " : "";
  // Login cannot store credentials while the registry token variable is set.
  const signIn = !readable && registryToken(alias) === undefined;
  if (signIn) context.printer.note("next", `aireg auth login ${alias}`);
  context.printer.note(signIn ? "then" : "next", `aireg add ${g}${alias}/<namespace>`);
}

/**
 * Decided and written under the scope's lease, against the manifest and lock as they are then,
 * so a command that writes the scope meanwhile is kept, not overwritten.
 */
async function settle(
  context: CommandContext,
  loaded: Loaded,
  dryRun: boolean,
  alias: string,
  declared: RegistrySource,
  source: Probed | undefined,
): Promise<{ declared: RegistrySource; move: Move | undefined }> {
  const decide = async ({ roots, manifest, lock }: Loaded) => {
    const move = await moveOf(roots, manifest, lock, alias, declared, source);
    const existing = manifest.registries[alias];
    // Another spelling of the same registry keeps the one its lock rows were resolved at.
    if (move !== undefined || existing === undefined) return { declared, move };
    return { declared: { ...declared, location: existing.location }, move };
  };
  if (dryRun) return decide(loaded);
  return withScope(
    loaded.roots,
    async (state) => {
      const settled = await decide(state);
      state.manifest.registries[alias] = settled.declared;
      await writeManifest(state.roots, state.manifest);
      if (settled.move !== undefined)
        await recordMove(state.roots, state.lock, alias, settled.declared, settled.move);
      return settled;
    },
    context.printer,
  );
}

/** Reports a move. Nothing installed is touched, since the new address was checked to serve it. */
async function moved(
  context: CommandContext,
  roots: Roots,
  alias: string,
  declared: RegistrySource,
  move: Move,
  dryRun: boolean,
): Promise<void> {
  const what = `registry ${alias} from ${withoutCredentials(move.from)} to ${withoutCredentials(declared.location)}`;
  const kept = plural(move.kept, "installed artifact");
  if (dryRun) {
    context.printer.info(`Would move ${what}, keeping ${kept}.`);
    context.printer.dryRun();
    return;
  }
  context.printer.success(`Moved ${what}.`);
  context.printer.note("kept", kept);
  if (await signInLeftBehind(roots, alias, declared, move)) {
    context.printer.warning(
      `Your sign-in to ${alias} is for its old address, so it does not reach the new one.`,
    );
    context.printer.note("next", `aireg auth login ${alias}`);
  }
}
