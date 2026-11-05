import { noSignIn } from "#accounts/service.ts";
import { failureOf, isAuthFailure } from "#adapter/errors.ts";
import {
  type Credential,
  type Identity,
  type OAuthClient,
  readProblem,
  type SourceAdapter,
} from "#adapter/index.ts";
import { withoutCredentials } from "#adapter/text.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { needsInput } from "#cli/options/parse.ts";
import { defaultIo } from "#cli/prompt/ask.ts";
import { cancel, interaction, interactive } from "#cli/prompt/interaction.ts";
import { canceled } from "#cli/prompt/model.ts";
import { confirm } from "#cli/prompt/select.ts";
import { adapterFor, declaredLayout } from "#core/adapter/load.ts";
import { open } from "#core/console/actions.ts";
import { type SignInPrompt, signInWithOAuth } from "#core/credentials/oauth.ts";
import { isCI, registryToken, tokenVariable } from "#core/env.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { readStdin } from "#core/process.ts";
import { withDaemon } from "#daemon/process/lifecycle.ts";
import { type Declared, declared, heldFor } from "./list.ts";
import { tokensOf } from "./shared.ts";

export interface LoginFlags {
  address?: string;
  adapter?: string;
  "token-stdin"?: boolean;
}

/** Over SSH the browser runs on another machine, and its redirect must be forwarded here. */
function remote(): boolean {
  return process.env.SSH_CONNECTION !== undefined || process.env.SSH_TTY !== undefined;
}

export async function login(
  context: CommandContext,
  registry: string | undefined,
  flags: LoginFlags,
  yes: boolean,
): Promise<void> {
  if (registry === undefined) {
    throw needsInput(
      "auth login",
      "a registry name",
      "Name the registry: `aireg auth login <registry>`, and pass `--address <address>` for one you have not declared.",
    );
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
  // CI has nobody at a browser. A terminal is not required: an agent's shell has none.
  const client =
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

const LOGIN_TIMEOUT_MS = 2 * 60_000;

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
