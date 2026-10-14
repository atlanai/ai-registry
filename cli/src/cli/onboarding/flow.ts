import { plural, sanitizeName, stripTrailing } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/index.ts";
import { probe } from "#cli/source.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { adapterFor } from "#core/adapter/registry.ts";
import { DEFAULT_INTERVAL_WORDS } from "#core/config/model.ts";
import { readConfig, writeConfig } from "#core/config/repository.ts";
import { contributedStepFlags } from "#core/host/load.ts";
import type { Scope } from "#core/store/paths.ts";
import { GLYPH } from "#core/term/theme.ts";
export interface OnboardingFlow {
  /** Where artifacts come from. Declared, signed in to, and pulled whole. */
  registry: string;
  alias: string | undefined;
  /** Named when the address alone does not say which adapter reads it. */
  adapter: string | undefined;
  /** `<registry>/<namespace>`: where work authored here is published. */
  namespace: string | undefined;
  tokenStdin: boolean;
  /** Whether to add a background job that keeps the project in sync. */
  watch: boolean;
}

export interface Step {
  name: string;
  detail: string;
}

/**
 * The one order that works: pull first, so a skill the registry already
 * publishes is recognized as theirs rather than imported as your own.
 */
export async function onboard(
  context: CommandContext,
  flow: OnboardingFlow,
  imports: readonly string[],
  scope: Scope,
): Promise<Step[]> {
  const done: Step[] = [];
  const alias = flow.alias ?? (await registryName(flow, context.cwd));
  const at = scopeArgv(scope);

  // Signing in declares the registry: a private one cannot be read without a
  // credential, and there is nowhere to hang one until it is declared.
  if (flow.tokenStdin) {
    const adapter = flow.adapter === undefined ? [] : ["--adapter", flow.adapter];
    await delegate("auth", context, [
      "login",
      alias,
      "--address",
      flow.registry,
      ...adapter,
      "--token-stdin",
    ]);
    done.push({ name: "signed in", detail: alias });
  } else {
    const adapter = flow.adapter === undefined ? [] : ["--adapter", flow.adapter];
    await delegate("registry", context, ["add", flow.registry, "--as", alias, ...adapter, ...at]);
  }
  done.push({ name: "registry", detail: `${alias} ${GLYPH.arrow} ${flow.registry}` });

  if (flow.namespace !== undefined) {
    await setNamespace(flow.namespace);
    await setAccountNamespace(alias, flow.namespace);
    done.push({ name: "namespace", detail: flow.namespace });
  }

  // Whole registry: a namespace added to it or removed must show up on the next
  // sync. A named-ref list goes stale.
  const added = (await delegate("add", context, [alias, "--all", "--yes", ...at])) as
    | { installed?: unknown[] }
    | undefined;
  const installed = added?.installed?.length ?? 0;
  done.push({ name: "pulled", detail: `${plural(installed, "artifact")} from ${alias}` });

  if (imports.length > 0) {
    // Runs after the pull on purpose: anything the registry already
    // publishes is claimed by the lock by now and is not imported again.
    const { applyImport, planImport } = await import("./import.ts");
    const planned = await planImport(context.cwd, imports, scope);
    // `<registry>/<namespace>`; with no namespace declared the registry
    // itself is the one it publishes under.
    const namespace = flow.namespace?.split("/").slice(1).join("/");
    const imported = await applyImport(planned, {
      registry: alias,
      namespace: namespace === undefined || namespace === "" ? alias : namespace,
    });
    done.push({ name: "imported", detail: `${imported} from ${imports.join(", ")}` });
  }

  if (await publishes(flow, context.cwd)) done.push(...(await publishLocal(context, alias, at)));

  if (flow.watch) {
    await delegate("job", context, ["add", "--registry", alias, ...at]);
    const account = (await readConfig()).accounts.find((entry) => entry.registry === alias);
    if (account !== undefined) {
      // Whatever the installed adapters contribute; aireg names no kind.
      for (const flag of Object.keys(await contributedStepFlags())) {
        try {
          await delegate("job", context, ["add", `--${flag}`, "--account", account.id]);
        } catch {
          // That adapter runs no job of its own; the skills job still watches.
        }
      }
    }
    done.push({ name: "watching", detail: `every ${DEFAULT_INTERVAL_WORDS}` });
  }

  return done;
}

/** Offers what was edited here, and is a step only when something was sent. */
async function publishLocal(
  context: CommandContext,
  alias: string,
  at: readonly string[],
): Promise<Step[]> {
  const sent = (await delegate("publish", context, ["--yes", ...at])) as
    | { artifacts?: { published?: boolean }[] }
    | undefined;
  const published = sent?.artifacts?.filter((item) => item.published === true).length ?? 0;
  return published === 0
    ? []
    : [{ name: "published", detail: `${plural(published, "artifact")} to ${alias}` }];
}

/** A git registry takes work through git, so there is nothing for aireg to offer it. */
async function publishes(flow: OnboardingFlow, cwd: string): Promise<boolean> {
  const adapter = await adapterFor(expandLocation(flow.registry, cwd), flow.adapter);
  return adapter.capabilities.publish !== false;
}

/** The scope `init` settled on, said the way each delegated command reads it. */
function scopeArgv(scope: Scope): string[] {
  return scope === "user" ? ["-g"] : [];
}

/**
 * Static imports, because a template literal here makes the bundler pull in
 * every file in the commands directory, test files included.
 */
const DELEGATES = {
  add: () => import("#cli/commands/add.ts"),
  auth: () => import("#cli/commands/auth.ts"),
  job: () => import("#cli/commands/job.ts"),
  publish: () => import("#cli/commands/publish.ts"),
  registry: () => import("#cli/commands/registry.ts"),
} as const;

/** Runs one step's command, whose result `init` reports in its own summary: the step's data. */
async function delegate(
  command: keyof typeof DELEGATES,
  context: CommandContext,
  argv: readonly string[],
): Promise<unknown> {
  const printed: string[] = [];
  const printer = context.printer.delegate({
    write: (chunk) => void printed.push(chunk),
    isTTY: false,
  });
  const loaded = await DELEGATES[command]();
  await loaded.run({ ...context, printer, argv: [...argv] });
  const last = printed.join("").trim().split("\n").at(-1);
  return last === undefined || last === ""
    ? undefined
    : (JSON.parse(last) as { data?: unknown }).data;
}

async function setAccountNamespace(alias: string, namespace: string): Promise<void> {
  const [, own] = namespace.split("/");
  if (own === undefined) return;
  const config = await readConfig();
  const accounts = config.accounts.map((account) =>
    account.registry === alias ? { ...account, defaultNamespace: own } : account,
  );
  await writeConfig({ ...config, accounts }, config.revision);
}

/** `init` checked it before writing anything. */
async function setNamespace(namespace: string): Promise<void> {
  const config = await readConfig();
  await writeConfig({ ...config, defaults: { ...config.defaults, namespace } }, config.revision);
}

/**
 * The name `aireg registry add` gives it: the one in its registry.json. One that cannot be
 * read before you sign in is named after its address instead.
 */
async function registryName(flow: OnboardingFlow, cwd: string): Promise<string> {
  const fallback = sanitizeName(lastSegment(flow.registry));
  if (flow.tokenStdin) return fallback;
  const source = await probe(flow.registry, { adapter: flow.adapter }, cwd).catch(() => undefined);
  if (source === undefined) return fallback;
  await source.close();
  return source.alias;
}

function lastSegment(location: string): string {
  let path = location;
  try {
    path = new URL(location).pathname;
  } catch {
    // Not a URL, so the whole address is the path.
  }
  const last = stripTrailing(path.replace(/\.git$/, ""), "/")
    .split(/[/:]/)
    .at(-1);
  return last === undefined || last === "" ? "registry" : last;
}
