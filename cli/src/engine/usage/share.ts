import { isNamespace } from "#adapter/filespec/names.ts";
import type { RegistryUsage } from "#adapter/index.ts";
import { quoted } from "#adapter/text.ts";
import type { UsageShare } from "#core/config/model.ts";
import { readConfig, updateConfig } from "#core/config/repository.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { homeDir } from "#core/fs/path.ts";
import { readLock } from "#core/lock.ts";
import { roots } from "#core/store/paths.ts";
import { collect } from "./collect.ts";
import type { SeenRegistry } from "./model.ts";
import { identityOf } from "./registry.ts";
import { readRegistries, withUsage, writeRegistries } from "./store.ts";

export interface Shared {
  share: UsageShare;
  usage: RegistryUsage;
}

/**
 * Agrees to send runs of one registry's artifacts to the endpoint its `registry.json` names now.
 * Runs counted before this stay on the machine.
 */
export async function shareWith(
  alias: string,
  as: string | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Shared> {
  const registry = await installedRegistry(alias, cwd, env);
  const usage = (await identityOf(registry))?.usage;
  if (usage === undefined) {
    throw new AiregError(`${quoted(alias)} does not ask for usage.`, {
      code: ErrorCode.Usage,
      hint: "Its registry.json names no usage endpoint, so there is nowhere to send runs.",
    });
  }
  const chosen = nameFor(usage, as, alias);
  const held = (await readConfig(env)).usage.find((item) => item.registry === registry.key);
  // Agreeing again to the same terms keeps the runs not yet sent, and when sending began.
  if (held !== undefined && sameTerms(held, usage, chosen)) return { share: held, usage };
  const share: UsageShare = {
    registry: registry.key,
    alias,
    otlp: usage.otlp,
    reporter: usage.reporter,
    precision: usage.timePrecision,
    since: new Date().toISOString(),
    ...(chosen === undefined ? {} : { as: chosen }),
  };
  // Counted first, so a run that happened before you agreed is in the store, and stays there.
  await collect(env);
  await withUsage(env, async () => {
    await writeRegistries({ ...(await readRegistries(env)), [registry.key]: registry }, env);
    await updateConfig(
      (config) => ({
        ...config,
        usage: [...config.usage.filter((item) => item.registry !== share.registry), share],
      }),
      env,
    );
  });
  return { share, usage };
}

function sameTerms(held: UsageShare, usage: RegistryUsage, chosen: string | undefined): boolean {
  return (
    held.otlp === usage.otlp &&
    held.reporter === usage.reporter &&
    held.precision === usage.timePrecision &&
    held.as === chosen
  );
}

/** Stops sending to one registry; returns what was turned off, or undefined when nothing was on. */
export async function stopSharing(
  alias: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UsageShare | undefined> {
  // Under the usage lease, so a send in progress stops before its next batch.
  return withUsage(env, async () => {
    const held = (await readConfig(env)).usage.find((share) => share.alias === alias);
    if (held === undefined) return undefined;
    await updateConfig(
      (config) => ({ ...config, usage: config.usage.filter((share) => share.alias !== alias) }),
      env,
    );
    return held;
  });
}

/** The registry under this alias in your user scope, or in the project `cwd` is in. */
async function installedRegistry(
  alias: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SeenRegistry> {
  for (const scope of [roots("project", cwd, env), roots("user", homeDir(env), env)]) {
    const held = (await readLock(scope)).registries[alias];
    if (held !== undefined) {
      return {
        key: held.key,
        alias,
        location: held.location,
        adapter: held.adapter,
        config: held.config,
      };
    }
  }
  throw new AiregError(`Nothing here is installed from a registry named ${quoted(alias)}.`, {
    code: ErrorCode.Usage,
    hint: "Run `aireg list` to see the registries you installed from.",
  });
}

/** Your name for a registry that asks for names; a registry that asks for pseudonyms gets one. */
function nameFor(usage: RegistryUsage, as: string | undefined, alias: string): string | undefined {
  if (usage.reporter === "pseudonym") {
    if (as !== undefined) {
      throw new AiregError(`${quoted(alias)} asks for pseudonyms, so it takes no name.`, {
        code: ErrorCode.Usage,
        hint: `Run \`aireg usage share ${alias}\` without --as.`,
      });
    }
    return undefined;
  }
  if (as === undefined) {
    throw new AiregError(`${quoted(alias)} asks for your name with each run.`, {
      code: ErrorCode.Usage,
      hint: `Choose one: \`aireg usage share ${alias} --as <name>\`, in lowercase letters, digits and hyphens.`,
    });
  }
  // Section 14.4: never an email address, and a name a registry path could hold.
  if (!isNamespace(as)) {
    throw new AiregError(`${quoted(as)} cannot be sent as your name.`, {
      code: ErrorCode.Usage,
      hint: "Use lowercase letters, digits and hyphens, such as jo-smith.",
    });
  }
  return as;
}
