import { quoted } from "#adapter/text.ts";
import type { UnlockResult } from "#cli/commands/unlock/result.ts";
import { UNLOCK_COMMAND } from "#cli/commands/unlock/spec.ts";
import { parse } from "#cli/options/parse.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { LeaseError } from "#core/lease/errors.ts";
import { breakLease, readLease } from "#core/lease/lease.ts";
import { scopeName } from "#core/store/paths.ts";
import { ago } from "#core/term/format.ts";
import type { CommonOptions } from "#engine/options.ts";
import { scopeRoots } from "#engine/scope/locate.ts";
import { defineCommand } from "./define.ts";

interface Options {
  common: CommonOptions;
  id: string | undefined;
}

/** Breaking a lease while its holder still writes corrupts the scope. */
export const { run } = defineCommand({
  spec: UNLOCK_COMMAND,
  parse(argv): Options {
    const { common, positionals } = parse(argv, UNLOCK_COMMAND);
    return { common, id: positionals[0] };
  },
  async run({ common, id }, context): Promise<UnlockResult> {
    const roots = scopeRoots(common, context.cwd);
    const holder = await readLease(roots);
    if (holder === undefined && id !== undefined) {
      throw new AiregError(
        `No lock with id ${quoted(id)}: nothing is writing to ${scopeName(roots.scope)}.`,
        { code: ErrorCode.Usage },
      );
    }
    if (holder === undefined) return { scope: roots.scope, held: false };
    if (id === undefined) return { scope: roots.scope, held: true, holder };

    try {
      const broken = await breakLease(roots, id);
      // Never silent: an undocumented workaround is worse than a logged one.
      context.printer.warning(
        `Cleared the write lock held by process ${broken.pid} on ${broken.host}.`,
      );
      return { scope: roots.scope, broken };
    } catch (error) {
      if (error instanceof LeaseError) {
        throw new AiregError(error.message, { code: ErrorCode.Usage, hint: error.hint });
      }
      throw error;
    }
  },
  text(result, printer) {
    const where = scopeName(result.scope);
    // The warning `run` printed is the whole report of a cleared lock.
    if ("broken" in result) return;
    if (!result.held) {
      printer.info(`Nothing is writing to ${where}.`);
      return;
    }
    const { holder } = result;
    printer.info(
      `Process ${holder.pid} on ${holder.host} started writing to ${where} ${ago(holder.acquiredAtMs)}.`,
    );
    // Showing the holder is the answer asked for, so it exits 0 as `--json` does.
    printer.hint(
      `If that process has stopped, run \`aireg unlock ${holder.id}\` to clear its write lock.`,
    );
  },
});
