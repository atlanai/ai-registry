import { canSignIn } from "#adapter/contract.ts";
import type { Credential } from "#adapter/index.ts";
import { withoutCredentials } from "#adapter/text.ts";
import { comparableLocation } from "#core/adapter/identity.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { adapterFor, declaredLayout } from "#core/adapter/registry.ts";
import type { Account } from "#core/config/model.ts";
import { readConfig } from "#core/config/repository.ts";
import { CredentialStoreError } from "#core/credentials/store.ts";
import { registryToken, tokenVariable } from "#core/env.ts";
import { ErrorCode } from "#core/errors.ts";
import type { RegistrySource } from "#core/manifest.ts";
import { readRootManifest } from "./registry.ts";
import { AccountService } from "./service.ts";

/**
 * The user's own files, which no project's manifest can change. credentials.json is not
 * among them: it is read only for a registry that could use a stored sign-in.
 */
interface Bindings {
  accounts: readonly Account[];
  declared: Readonly<Record<string, RegistrySource>>;
}

async function bindings(): Promise<Bindings> {
  const [{ accounts }, user] = await Promise.all([readConfig(), readRootManifest("user")]);
  return { accounts, declared: user.registries };
}

function declaredAt(found: Bindings, alias: string): string | undefined {
  const declared = found.declared[alias];
  return declared === undefined ? undefined : expandLocation(declared.location, process.cwd());
}

type Source = Pick<RegistrySource, "adapter"> & Partial<Pick<RegistrySource, "config">>;

/** Git and folder sources take none: git brings its own credentials, and a folder needs none. */
async function signsIn(source: Source, location: string) {
  const layout = source.config === undefined ? undefined : declaredLayout(source.config);
  const adapter = await adapterFor(location, source.adapter, layout).catch(() => undefined);
  return adapter !== undefined && canSignIn(adapter);
}

/** What one lookup shares across the registries it resolves. */
interface Lookup {
  found: Bindings;
  aliases: readonly string[];
  service: AccountService;
  signal: AbortSignal;
}

async function lookup(signal: AbortSignal, aliases: readonly string[] = []): Promise<Lookup> {
  const found = await bindings();
  return {
    found,
    aliases: [...aliases, ...Object.keys(found.declared)],
    service: new AccountService(),
    signal,
  };
}

/**
 * Sent to the registry the current scope declares under `alias`, the one the
 * command works on; an address nothing declares under that name gets none.
 */
function fromEnvironment(
  alias: string,
  location: string,
  declared: boolean,
  aliases: readonly string[],
): Credential | undefined {
  const token = registryToken(alias);
  if (token === undefined) return undefined;
  const variable = tokenVariable(alias);
  if (!declared) {
    const where = withoutCredentials(location);
    throw new CredentialStoreError(
      `${variable} is set, but ${where} is not declared as ${alias}, so aireg does not send it there.`,
      {
        code: ErrorCode.Unauthorized,
        hint: `To send it there, declare it: \`aireg registry add ${where} --as ${alias}\`.`,
      },
    );
  }
  // Variable names fold case and punctuation, so two aliases can read one token.
  const sharing = [...new Set(aliases)]
    .filter((other) => other !== alias && tokenVariable(other) === variable)
    .sort();
  if (sharing.length > 0) {
    throw new CredentialStoreError(
      `${variable} names both ${alias} and ${sharing.join(", ")}, so aireg sends it to neither. Rename one of them.`,
    );
  }
  return { type: "bearer", accessToken: token };
}

/**
 * `AIREG_TOKEN_<NAME>` wins over a stored sign-in. A stored one goes only to the
 * origin it was issued for, whatever address a project declares for its name; an
 * address nothing declares, which only a probe asks about, gets none from another origin.
 */
async function release(
  alias: string,
  source: Source,
  location: string,
  declared: boolean,
  { found, aliases, service, signal }: Lookup,
): Promise<Credential | undefined> {
  const account = found.accounts.find(({ registry }) => registry === alias);
  if (account === undefined && registryToken(alias) === undefined) return undefined;
  if (!(await signsIn(source, location))) return undefined;
  const fromEnv = fromEnvironment(alias, location, declared, aliases);
  if (fromEnv !== undefined || account === undefined) return fromEnv;
  if (!declared && !(await service.issuedFor(account, location))) return undefined;
  return service.signedInCredential(account, location, signal);
}

/**
 * Undefined is the ordinary case: most registries need no account at all.
 * `alias` is the name the current scope declares at `location`.
 */
export async function credentialFor(
  alias: string,
  source: Source,
  location: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<Credential | undefined> {
  return release(alias, source, location, true, await lookup(signal, [alias]));
}

/**
 * Keyed by alias because that is how `acquire` asks for them, and skipping the
 * registries nobody is signed in to so an unauthenticated source stays free.
 */
export async function credentialsForManifest(
  registries: Readonly<Record<string, RegistrySource>>,
  cwd: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<Record<string, Credential>> {
  const shared = await lookup(signal, Object.keys(registries));
  const resolved = await Promise.all(
    Object.entries(registries).map(async ([alias, source]) => ({
      alias,
      credential: await release(alias, source, expandLocation(source.location, cwd), true, shared),
    })),
  );

  const credentials: Record<string, Credential> = {};
  for (const { alias, credential } of resolved) {
    if (credential !== undefined) credentials[alias] = credential;
  }
  return credentials;
}

/**
 * `probe` names a registry by address because nothing has declared it yet, so the
 * account is the one whose user declaration is that address, else the one named `alias`.
 */
export async function credentialForLocation(
  location: string,
  alias: string,
  source: Source,
): Promise<Credential | undefined> {
  const signal = new AbortController().signal;
  const shared = await lookup(signal, [alias]);
  const { found } = shared;
  const wanted = comparableLocation(location);
  const account = found.accounts.find((candidate) => {
    const declared = declaredAt(found, candidate.registry);
    return declared !== undefined && comparableLocation(declared) === wanted;
  });
  const declared = account === undefined ? undefined : found.declared[account.registry];
  if (account !== undefined && declared !== undefined && (await signsIn(declared, location))) {
    const credential = await shared.service.signedInCredential(account, location, signal);
    if (credential !== undefined) return credential;
  }
  return release(alias, source, location, false, shared);
}
