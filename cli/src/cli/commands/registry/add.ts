import { canSignIn } from "#adapter/contract.ts";
import { isAdapterError } from "#adapter/index.ts";
import { plural, withoutCredentials } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { action } from "#cli/commands/define.ts";
import { type Move, moveOf, recordMove, signInLeftBehind } from "#cli/commands/registry/move.ts";
import type { RegistryAdded } from "#cli/commands/registry/result.ts";
import { needsInput } from "#cli/options/parse.ts";
import { noteUserScope } from "#cli/render/where.ts";
import { loadAdapter } from "#core/adapter/load.ts";
import { expandLocation, recordedLocation } from "#core/adapter/location.ts";
import { registryToken } from "#core/env.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { RegistrySource } from "#core/manifest/model.ts";
import { writeManifest } from "#core/manifest/repository.ts";
import type { Scope } from "#core/store/paths.ts";
import type { Printer } from "#core/term/printer.ts";
import { type Probed, probe, sourceConfig } from "#engine/address/probe.ts";
import { type Loaded, load, withScope } from "#engine/scope/load.ts";
import type { Options } from "./options.ts";
import { described } from "./shared.ts";

interface Added {
  data: RegistryAdded;
  label: string | undefined;
  fromAddress: boolean;
  scope: Scope;
  cwd: string;
  /** Login cannot store credentials while the registry token variable is set. */
  signIn: boolean;
  signInLeftBehind: boolean;
}

export const add = action({
  async run({ argument: input, flags, common }: Options, context): Promise<Added> {
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
      const source = await probe({ input, flags, cwd: context.cwd });
      try {
        declared = {
          ...source.declared,
          location: recordedLocation(input, source.declared.location, loaded.roots),
        };
        alias = flags.as ?? source.alias;
        label = source.label;
        fromAddress = flags.as === undefined && source.named === "address";
        ({ declared, move } = await settle(
          context,
          loaded,
          common.dryRun,
          alias,
          declared,
          source,
        ));
      } finally {
        await source.close();
      }
    } catch (error) {
      if (!(error instanceof AiregError) || error.code !== ErrorCode.Unauthorized) throw error;
      // Adapters that manage credentials without a sign-in flow cannot recover after declaration.
      // One that will not load is taken to allow a sign-in, which then says why it fails.
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
      ({ declared, move } = await settle(
        context,
        loaded,
        common.dryRun,
        alias,
        declared,
        undefined,
      ));
    }

    return {
      data: {
        ...described(alias, declared),
        ...(move === undefined
          ? {}
          : { movedFrom: withoutCredentials(move.from), kept: move.kept }),
        readable,
        dryRun: common.dryRun,
      },
      label,
      fromAddress,
      scope: loaded.roots.scope,
      cwd: context.cwd,
      signIn: !readable && registryToken(alias) === undefined,
      signInLeftBehind:
        move !== undefined &&
        !common.dryRun &&
        (await signInLeftBehind(loaded.roots, alias, declared, move)),
    };
  },
  data: (result) => result.data,
  text(result, printer, { common }) {
    const { data } = result;
    if (data.movedFrom !== undefined && data.kept !== undefined) {
      moved(printer, result, data.movedFrom, data.kept);
      return;
    }
    if (data.dryRun) {
      printer.info(`Would add registry ${data.registry} at ${data.address}.`);
      printer.dryRun();
      return;
    }
    printer.success(`Added registry ${data.registry} at ${data.address}.`);
    if (result.label !== undefined) printer.note("about", result.label);
    if (result.fromAddress) printer.note("named", "after its address; choose another with --as");
    noteUserScope(printer, common.scope, result.cwd);
    const g = result.scope === "user" ? "-g " : "";
    if (result.signIn) printer.note("next", `aireg auth login ${data.registry}`);
    printer.note(result.signIn ? "then" : "next", `aireg add ${g}${data.registry}/<namespace>`);
  },
});

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

function moved(printer: Printer, result: Added, from: string, kept: number): void {
  const { data } = result;
  const what = `registry ${data.registry} from ${from} to ${data.address}`;
  const count = plural(kept, "installed artifact");
  if (data.dryRun) {
    printer.info(`Would move ${what}, keeping ${count}.`);
    printer.dryRun();
    return;
  }
  printer.success(`Moved ${what}.`);
  printer.note("kept", count);
  if (result.signInLeftBehind) {
    printer.warning(
      `Your sign-in to ${data.registry} is for its old address, so it does not reach the new one.`,
    );
    printer.note("next", `aireg auth login ${data.registry}`);
  }
}
