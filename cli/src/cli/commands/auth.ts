import { heldAt } from "#accounts/registry.ts";
import { AccountService, noSignIn } from "#accounts/service.ts";
import { failureOf, isAuthFailure } from "#adapter/errors.ts";
import {
  type Credential,
  type Identity,
  type OAuthClient,
  readProblem,
  type SourceAdapter,
} from "#adapter/index.ts";
import { plural, quoted, withoutCredentials } from "#adapter/text.ts";
import { parse } from "#cli/options.ts";
import { cancel, interaction, interactive } from "#cli/prompt/flow.ts";
import { canceled, confirm, defaultIo } from "#cli/prompt/index.ts";
import { comparableLocation } from "#core/adapter/identity.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { adapterFor, declaredLayout } from "#core/adapter/registry.ts";
import type { Account } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { open } from "#core/console/actions.ts";
import { type SignInPrompt, signInWithOAuth } from "#core/credentials/oauth.ts";
import { signedInAccounts } from "#core/credentials/store.ts";
import { isCI, registryToken, tokenVariable } from "#core/env.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { type RegistrySource, readManifest } from "#core/manifest.ts";
import { readStdin } from "#core/process.ts";
import { roots } from "#core/store/paths.ts";
import { table } from "#core/term/table.ts";
import { withDaemon } from "#daemon/service.ts";
import { locate } from "#engine/pipeline.ts";
import { builtin, type CommandContext, runAction } from "./index.ts";

/** Accepts either handle, because the id is what a job stores and the alias is what a person types. */
function findAccount(accounts: readonly Account[], wanted: string): Account | undefined {
  return accounts.find(({ id, registry }) => id === wanted || registry === wanted);
}

/**
 * A job keeps an account for a folder or git registry too, which has nothing to sign in
 * to. One whose registry cannot be read now is taken to need a sign-in.
 */
async function needsSignIn(service: AccountService, account: Account): Promise<boolean> {
  try {
    return (await service.resolve(account)).adapter.auth?.login !== undefined;
  } catch {
    return true;
  }
}

async function list(context: CommandContext): Promise<void> {
  const config = await readConfig();
  const signedIn = await signedInAccounts();
  const service = new AccountService();
  const needs = new Map(
    await Promise.all(
      config.accounts.map(
        async (account) => [account.id, await needsSignIn(service, account)] as const,
      ),
    ),
  );
  if (context.printer.format === "json") {
    const accounts = config.accounts.map((account) => ({
      ...account,
      signedIn: signedIn.has(account.id),
      needsSignIn: needs.get(account.id) ?? true,
    }));
    context.printer.json({ ok: true, data: { accounts } });
    return;
  }
  if (config.accounts.length === 0) {
    context.printer.info("No accounts yet.");
    context.printer.hint("Run `aireg auth login <registry>` to sign in.");
    return;
  }
  const { style } = context.printer;
  const rows = config.accounts.map((account) => ({
    account,
    on: signedIn.has(account.id),
    needed: needs.get(account.id) ?? true,
  }));
  context.printer.info(style.bold(plural(rows.length, "account")));
  table(
    context.printer,
    [
      { header: "registry", value: (row: (typeof rows)[number]) => row.account.registry },
      {
        header: "state",
        value: (row: (typeof rows)[number]) =>
          !row.needed
            ? style.dim("no sign-in")
            : row.on
              ? style.green("signed in")
              : style.yellow("signed out"),
      },
      {
        header: "namespace",
        value: (row: (typeof rows)[number]) => row.account.defaultNamespace ?? "",
        optional: true,
      },
      { header: "account", value: (row: (typeof rows)[number]) => style.dim(row.account.id) },
    ],
    rows,
  );
}

interface LoginFlags {
  address?: string;
  adapter?: string;
  "token-stdin"?: boolean;
}

/**
 * Never an argument: argv is visible to `ps` and lands in shell history, so it comes
 * from a pipe. One in the environment is used where it is set and never written to disk.
 */
async function resolveToken(registry: string, flags: LoginFlags): Promise<string | undefined> {
  // A stored sign-in would never be used while it is set, so storing one would mislead.
  if (registryToken(registry) !== undefined) {
    const variable = tokenVariable(registry);
    throw new AiregError(`${variable} is set, so aireg already uses it for ${registry}.`, {
      code: ErrorCode.Conflict,
      hint:
        `Nothing was stored, since commands here would go on using ${variable}. ` +
        "To store a sign-in, which background jobs need, unset it and run this again.",
    });
  }
  if (flags["token-stdin"] === true) {
    // A token typed here would echo into the terminal and its scrollback.
    if (process.stdin.isTTY === true) {
      throw new AiregError("--token-stdin reads a pipe, not the terminal.", {
        code: ErrorCode.Usage,
        hint: `Pipe the token in: \`… | aireg auth login ${registry} --token-stdin\`.`,
      });
    }
    const piped = (await readStdin()).trim();
    if (piped === "") {
      throw new AiregError("No token arrived on standard input.", {
        code: ErrorCode.Usage,
        hint: `Pipe the token in: \`… | aireg auth login ${registry} --token-stdin\`.`,
      });
    }
    return piped;
  }
  return undefined;
}

/** Over SSH the browser runs on another machine, and its redirect must be forwarded here. */
function remote(): boolean {
  return process.env.SSH_CONNECTION !== undefined || process.env.SSH_TTY !== undefined;
}

/** On stderr even with --json: the sign-in cannot finish without the link. */
const prompt: SignInPrompt = {
  open(url) {
    // A $BROWSER over SSH, such as an editor's remote helper, reaches the person's own browser.
    if (!remote() || process.env.BROWSER !== undefined) open(url);
  },
  waiting(url, port) {
    process.stderr.write(
      remote()
        ? `Open ${url} in a browser, after forwarding its port: \`ssh -L ${port}:127.0.0.1:${port} <this host>\`.\n`
        : `Opening ${url} in your browser.\n`,
    );
    process.stderr.write("Waiting for you to sign in there. Press Ctrl+C to cancel.\n");
  },
};

function tokensOf(credential: Credential): {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
} {
  if (credential.type !== "bearer") throw new AiregError("The sign-in returned no bearer token.");
  const { accessToken, refreshToken, expiresAtMs } = credential;
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
  };
}

interface Declared {
  source: RegistrySource;
  location: string;
  /** Only the project declares it, so signing in declares it for the user too. */
  projectOnly: boolean;
}

/**
 * Found where `aireg add` finds it, the project before the user scope. An
 * account is the user's, so one alias cannot sign in to two sources.
 */
async function declared(alias: string, cwd: string): Promise<Declared | undefined> {
  const user = (await readManifest(roots("user", cwd).manifest)).registries[alias];
  const project = locate(undefined, cwd);
  const here =
    project === undefined
      ? undefined
      : (await readManifest(roots("project", project.base).manifest)).registries[alias];
  if (project === undefined || here === undefined) {
    return user === undefined
      ? undefined
      : { source: user, location: expandLocation(user.location, cwd), projectOnly: false };
  }
  const location = expandLocation(here.location, project.base);
  const theirs = user === undefined ? undefined : expandLocation(user.location, cwd);
  if (theirs !== undefined && comparableLocation(theirs) !== comparableLocation(location)) {
    throw new AiregError(
      `${alias} is ${withoutCredentials(location)} in this project but ${withoutCredentials(theirs)} in your user scope.`,
      {
        code: ErrorCode.Usage,
        hint: "An account signs in to one registry, so declare one of them under another name: `aireg registry add <address> --as <name>`.",
      },
    );
  }
  // The daemon signs in with the user scope's declaration, so the browser goes where it will.
  if (user !== undefined && theirs !== undefined) {
    return { source: user, location: theirs, projectOnly: false };
  }
  return { source: here, location, projectOnly: true };
}

async function heldFor(alias: string, address: string, cwd: string): Promise<Declared | undefined> {
  const { registries } = await readManifest(roots("user", cwd).manifest);
  const held = heldAt(registries, alias, address, cwd);
  return held === undefined
    ? undefined
    : { source: held, location: expandLocation(held.location, cwd), projectOnly: false };
}

function failureHint(
  registry: string,
  given: { token: string | undefined; oauth: boolean },
  own: unknown,
): string | undefined {
  // After an OAuth sign-in the adapter knows what went wrong; a missing token is not it.
  if (given.oauth) return typeof own === "string" ? own : undefined;
  if (given.token !== undefined) return undefined;
  return (
    `Pipe one in with \`… | aireg auth login ${registry} --token-stdin\`, ` +
    `or set ${tokenVariable(registry)}.`
  );
}

/** The adapter's own refusal, with exit 4 when it is about the credential. */
function loginFailure(
  error: unknown,
  registry: string,
  given: { token: string | undefined; oauth: boolean },
): unknown {
  const data = (error as { data?: unknown } | undefined)?.data;
  const problem = readProblem(undefined, data);
  if (problem === undefined || !(error instanceof Error)) return error;
  const failure = failureOf(problem);
  if (!isAuthFailure(failure)) return error;
  const hint = failureHint(registry, given, (data as { hint?: unknown }).hint);
  return new AiregError(error.message, {
    code: ErrorCode.Unauthorized,
    cause: error,
    ...(hint === undefined ? {} : { hint }),
  });
}

/**
 * Signing in declares a project's address in your user scope, which is what tokens are
 * bound to, so an address only a cloned project chose is shown and agreed to first.
 */
async function signsInThere(
  context: CommandContext,
  registry: string,
  declaring: Declared,
  yes: boolean,
): Promise<boolean> {
  if (yes) return true;
  const address = withoutCredentials(declaring.location);
  const step = interaction(context.printer, defaultIo(), false);
  if (!interactive(step)) {
    throw new AiregError(`Only this project declares ${registry}, at ${address}.`, {
      code: ErrorCode.Usage,
      hint: `To sign in there, pass \`--yes\` or name it: \`aireg auth login ${registry} --address ${address}\`.`,
    });
  }
  const agreed = await confirm(
    {
      message: `Only this project declares ${registry}, at ${address}. Sign in there?`,
      style: context.printer.errStyle,
      initial: false,
    },
    step.io,
  );
  if (canceled(agreed) || !agreed) {
    cancel(step);
    return false;
  }
  return true;
}

const LOGIN_TIMEOUT_MS = 2 * 60_000;

async function oauthClientFor(
  found: Declared | undefined,
  signsIn: SourceAdapter | undefined,
  flags: LoginFlags,
): Promise<OAuthClient | undefined> {
  if (found !== undefined) return signsIn?.auth?.oauth?.(found.location, found.source.config ?? {});
  if (flags.address === undefined) return undefined;
  // Unresolvable here is not a failure: the daemon resolves it again and says why.
  const named = await adapterFor(flags.address, flags.adapter).catch(() => undefined);
  return named?.auth?.oauth?.(flags.address, {});
}

function report(
  context: CommandContext,
  { account, identity }: { account: { registry: string }; identity?: Identity | undefined },
  where: string | undefined,
): void {
  const at = where === undefined ? "" : ` at ${withoutCredentials(where)}`;
  const who =
    identity === undefined
      ? ""
      : ` as ${identity.name}${identity.account === undefined ? "" : ` (${identity.account})`}`;
  context.printer.format === "json"
    ? context.printer.json({
        ok: true,
        data: { account, ...(identity === undefined ? {} : { identity }) },
      })
    : context.printer.success(`Signed in to ${account.registry}${at}${who}.`);
}

async function login(
  context: CommandContext,
  registry: string | undefined,
  flags: LoginFlags,
  yes: boolean,
): Promise<void> {
  if (registry === undefined) {
    throw new AiregError("`aireg auth login` needs a registry name.", {
      code: ErrorCode.Usage,
      hint: "Name the registry: `aireg auth login <registry>`, and pass `--address <address>` for one you have not declared.",
    });
  }

  const found =
    flags.address === undefined
      ? await declared(registry, context.cwd)
      : await heldFor(registry, flags.address, context.cwd);
  const signsIn =
    found === undefined
      ? undefined
      : await adapterFor(found.location, found.source.adapter, declaredLayout(found.source.config));
  if (signsIn !== undefined && signsIn.auth?.login === undefined) {
    throw new AiregError(noSignIn(registry, signsIn.credentialsHint !== undefined), {
      code: ErrorCode.Usage,
      hint: signsIn.credentialsHint,
    });
  }
  const declaring = found?.projectOnly === true ? found : undefined;
  if (declaring !== undefined && !(await signsInThere(context, registry, declaring, yes))) return;
  const address = flags.address ?? declaring?.location;
  const adapter = flags.adapter ?? declaring?.source.adapter;
  const config = declaring?.source.config ?? {};

  const where = flags.address ?? found?.location;
  const token = await resolveToken(registry, flags);
  const client =
    // CI has nobody at a browser. A terminal is not required: an agent's shell has none.
    token === undefined && !isCI() ? await oauthClientFor(found, signsIn, flags) : undefined;
  let finishing = false;
  const signIn = (oauth?: Credential) => {
    finishing = true;
    return withDaemon((daemon) =>
      daemon.request(
        "account.login",
        {
          registry,
          ...(token === undefined ? {} : { token }),
          ...(oauth === undefined ? {} : { oauth: tokensOf(oauth) }),
          ...(address === undefined ? {} : { address }),
          ...(adapter === undefined ? {} : { adapter }),
          ...(Object.keys(config).length === 0 ? {} : { config }),
        },
        // Signing in may switch orgs and end a replaced session, each a round trip of its own.
        { timeoutMs: LOGIN_TIMEOUT_MS },
      ),
    );
  };
  // Ctrl+C while the browser is out ends the wait and closes the port, rather than the process.
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (client !== undefined) process.once("SIGINT", stop);
  try {
    const signedIn = await (client === undefined
      ? signIn()
      : signInWithOAuth(client, prompt, controller.signal, signIn));
    report(context, signedIn, where);
  } catch (error) {
    // Once the daemon has the sign-in, Ctrl+C no longer stops it, so its own outcome stands.
    if (controller.signal.aborted && !finishing) {
      context.printer.info("Canceled. Nothing was changed.");
      return;
    }
    throw loginFailure(error, registry, { token, oauth: client !== undefined });
  } finally {
    process.off("SIGINT", stop);
  }
}

const LOGOUT_OR_REMOVE =
  "Use logout to sign out and keep the account for its jobs, or remove to delete it.";

function needsRegistry(action: string): AiregError {
  return new AiregError(`\`aireg auth ${action}\` needs a registry name.`, {
    code: ErrorCode.Usage,
    hint: `Name the registry: \`aireg auth ${action} <registry>\`.`,
  });
}

function noAccount(wanted: string): AiregError {
  return new AiregError(`No account named ${quoted(wanted)}.`, {
    code: ErrorCode.NotFound,
    hint: "Run `aireg auth list` to see the accounts.",
  });
}

/** Clears the credential and keeps the row, so every job keeps its reference. */
async function logout(context: CommandContext, wanted: string | undefined): Promise<void> {
  if (wanted === undefined) throw needsRegistry("logout");
  const account = findAccount((await readConfig()).accounts, wanted);
  if (account === undefined) throw noAccount(wanted);
  await withDaemon(async (client) => {
    await client.request("account.logout", { accountId: account.id });
    context.printer.format === "json"
      ? context.printer.json({ ok: true, data: { accountId: account.id } })
      : context.printer.success(
          `Signed out of ${account.registry}, keeping the account for its jobs.`,
        );
  });
}

/** Explicit and separate from signing out: this is the one that breaks jobs. */
async function remove(context: CommandContext, wanted: string | undefined): Promise<void> {
  if (wanted === undefined) throw needsRegistry("remove");
  const config = await readConfig();
  const account = findAccount(config.accounts, wanted);
  if (account === undefined) throw noAccount(wanted);
  const jobs = config.jobs.filter(({ account: id }) => id === account.id);
  if (jobs.length > 0) {
    throw new AiregError(
      `The account for ${account.registry} is used by ${plural(jobs.length, "job")}.`,
      {
        code: ErrorCode.Conflict,
        hint: `Remove those jobs first with \`aireg job remove <job>\`, or run \`aireg auth logout ${account.registry}\` to keep them.`,
      },
    );
  }
  await withDaemon(async (client) => {
    await client.request("account.remove", { accountId: account.id });
    context.printer.format === "json"
      ? context.printer.json({ ok: true, data: { accountId: account.id } })
      : context.printer.success(`Removed the account for ${account.registry}.`);
  });
}

export async function run(context: CommandContext): Promise<void> {
  const spec = builtin("auth");
  const { positionals, own, common } = parse<LoginFlags & Record<string, unknown>>(
    context.argv,
    spec,
  );
  const [action = "list", argument] = positionals;
  return runAction(
    spec,
    action,
    {
      list: () => list(context),
      login: () => login(context, argument, own, common.yes),
      logout: () => logout(context, argument),
      remove: () => remove(context, argument),
    },
    LOGOUT_OR_REMOVE,
  );
}
