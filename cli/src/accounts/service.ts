import { messageOf } from "#adapter/errors.ts";
import {
  AdapterError,
  type Credential,
  type Identity,
  isAdapterError,
  type SourceAdapter,
  type SourceContext,
} from "#adapter/index.ts";
import { list, plural, quoted, sanitizeText, withoutCredentials } from "#adapter/text.ts";
import { hostServices } from "#core/adapter/connect.ts";
import type { SourceConfig } from "#core/adapter/identity.ts";
import type { Account, RegistryConfig } from "#core/config/model.ts";
import { readConfig, writeConfig } from "#core/config/repository.ts";
import { credentialOrigin } from "#core/credentials/origin.ts";
import {
  CredentialStoreError,
  deleteCredential,
  newAccountId,
  readCredential,
  type StoredCredential,
  saveCredential,
} from "#core/credentials/store.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import { withLease } from "#core/lease/lease.ts";
import { credentialsPath, type Scope } from "#core/store/paths.ts";
import {
  declareRegistryFor,
  type ResolvedRegistry,
  readRootManifest,
  resolveRegistry,
} from "./registry.ts";

export interface LoginResult {
  account: Account;
  /** False means an existing row kept its id, so every job naming it keeps working. */
  created: boolean;
  /** Who the registry says signed in, shown once and never stored. */
  identity: Identity | undefined;
}

export interface LoginAccount {
  registry: string;
  /** Declares the registry in your user scope when its manifest does not name it yet. */
  address?: string;
  adapter?: string;
  config?: SourceConfig;
  defaultNamespace?: string;
}

function upsert(accounts: readonly Account[], account: Account): Account[] {
  const next = accounts.filter(({ id }) => id !== account.id);
  next.push(account);
  return next.sort((left, right) => left.registry.localeCompare(right.registry));
}

/** The registry's own words, made safe to print; one that names nobody says nothing. */
function shownIdentity(identity: Identity | undefined): Identity | undefined {
  const name = typeof identity?.name === "string" ? sanitizeText(identity.name) : "";
  if (name === "") return undefined;
  const account = typeof identity?.account === "string" ? sanitizeText(identity.account) : "";
  return account === "" ? { name } : { name, account };
}

/** Folder and git registries have none: git brings its own credentials. */
export function noSignIn(alias: string, ownCredentials: boolean): string {
  return ownCredentials
    ? `aireg keeps no sign-in for ${alias}, which is read with your own credentials.`
    : `${alias} needs no sign-in, so there is nothing to log in to.`;
}

function expiring(credential: Credential): boolean {
  return (
    credential.type === "bearer" &&
    credential.expiresAtMs !== undefined &&
    credential.expiresAtMs <= Date.now() + 60_000
  );
}

/** Ending an abandoned sign-in outlives a canceled request, but not by longer than this. */
const REVOKE_MS = 30_000;

/** One change to an account's sign-in at a time: a refresh racing a login or logout writes back the old one. */
function changing<T>(accountId: string, change: () => Promise<T>): Promise<T> {
  return withLease(
    { scope: "user", lock: `${credentialsPath()}.${accountId}` },
    { wait: true },
    change,
  );
}

/** A session the registry minted; an operator's token may still serve elsewhere, as in CI. */
function isSession(credential: Credential): boolean {
  return credential.type === "bearer" && credential.refreshToken !== undefined;
}

function endedSession(replaced: Credential, current: Credential): boolean {
  if (replaced.type !== "bearer" || replaced.refreshToken === undefined) return false;
  return !(current.type === "bearer" && current.refreshToken === replaced.refreshToken);
}

/** Best effort: the registry may be unreachable, and the sign-out on this machine still stands. */
async function revoke(
  resolved: ResolvedRegistry,
  credential: Credential,
  signal: AbortSignal,
): Promise<void> {
  await Promise.resolve(
    resolved.adapter.auth?.revoke?.(resolved.location, credential, signal),
  ).catch(() => undefined);
}

function signedOut(account: Account): CredentialStoreError {
  return new CredentialStoreError(`You are signed out of ${account.registry}.`, {
    code: ErrorCode.Unauthorized,
    hint: `Run \`aireg auth login ${account.registry}\`.`,
  });
}

/**
 * A sign-in goes only to the origin it was issued for, so a project that points
 * the name somewhere else gets none.
 */
function assertBound(account: Account, stored: StoredCredential, location: string): void {
  const origin = credentialOrigin(location);
  if (origin === stored.origin) return;
  throw new CredentialStoreError(
    `Your sign-in for ${account.registry} is for ${stored.origin}, so aireg does not send it to ${origin ?? withoutCredentials(location)}.`,
    {
      code: ErrorCode.Unauthorized,
      hint: `If ${account.registry} has moved, sign in again with \`aireg auth login ${account.registry}\`. If this is another registry, declare it under another name: \`aireg registry add <address> --as <name>\`.`,
    },
  );
}

export class AccountService {
  /** From the manifest of `scope`: a project may declare a registry the user scope never does. */
  async resolve(
    account: Account,
    scope: Scope = "user",
    cwd = process.cwd(),
  ): Promise<ResolvedRegistry> {
    const manifest = await readRootManifest(scope, cwd);
    return resolveRegistry(manifest, account.registry, scope, cwd);
  }

  /**
   * Upserts by registry: a fresh id per sign-in would leave every job that
   * named the old one dangling.
   */
  async login(
    input: LoginAccount,
    given: { token?: string | undefined; oauth?: Credential | undefined },
    signal: AbortSignal,
  ): Promise<LoginResult> {
    const alias = input.registry;
    if (input.address !== undefined) {
      await declareRegistryFor(alias, {
        location: input.address,
        adapter: input.adapter,
        config: input.config ?? {},
      });
    }
    const resolved = await resolveRegistry(await readRootManifest(), alias, "user");
    if (resolved.adapter.auth?.login === undefined) {
      throw new AdapterError(
        resolved.adapter.id,
        "invalid",
        noSignIn(alias, resolved.adapter.credentialsHint !== undefined),
        { hint: resolved.adapter.credentialsHint },
      );
    }
    const origin = credentialOrigin(resolved.location);
    if (origin === undefined) {
      throw new AdapterError(
        resolved.adapter.id,
        "invalid",
        `${alias} is at ${withoutCredentials(resolved.location)}, which is not a web address a sign-in can be bound to.`,
      );
    }

    const before = await readConfig();
    const session = await resolved.adapter.auth
      .login({
        endpoint: resolved.location,
        config: resolved.source.config ?? {},
        signal,
        token: given.token,
        ...(given.oauth === undefined ? {} : { oauth: given.oauth }),
      })
      .catch((error: unknown) => {
        if (isAdapterError(error)) throw error;
        // A sign-in that failed is one still needed, whatever the adapter threw.
        throw new AdapterError(resolved.adapter.id, "unauthorized", messageOf(error), {
          cause: error,
        });
      });
    const held = before.accounts.find(({ registry }) => registry === alias);
    const id = held?.id ?? newAccountId();
    let saved = false;
    try {
      const replaced = await changing(id, async () => {
        const previous = await readCredential(id);
        await saveCredential(id, { origin, credential: session.credential });
        saved = true;
        return previous;
      });
      if (
        replaced !== undefined &&
        replaced.origin === origin &&
        endedSession(replaced.credential, session.credential)
      ) {
        await revoke(resolved, replaced.credential, signal);
      }
      const defaultNamespace = input.defaultNamespace ?? held?.defaultNamespace;
      const account: Account = {
        id,
        registry: alias,
        ...(defaultNamespace === undefined ? {} : { defaultNamespace }),
      };
      const latest = await readConfig();
      await writeConfig({ ...latest, accounts: upsert(latest.accounts, account) }, latest.revision);
      return { account, created: held === undefined, identity: shownIdentity(session.identity) };
    } catch (error) {
      // No account row reaches a sign-in stored for a new one, so no sign-out would ever end it.
      if (saved && held === undefined) await changing(id, () => deleteCredential(id));
      if ((!saved || held === undefined) && isSession(session.credential)) {
        await revoke(resolved, session.credential, AbortSignal.timeout(REVOKE_MS));
      }
      throw error;
    }
  }

  /** Deletes the sign-in and keeps the row, so jobs keep their reference. */
  async logout(accountId: string, signal: AbortSignal): Promise<RegistryConfig> {
    const config = await readConfig();
    const account = config.accounts.find(({ id }) => id === accountId);
    if (account === undefined) {
      throw new AiregError(`No account named ${quoted(accountId)}.`, {
        code: ErrorCode.NotFound,
        hint: "Run `aireg auth list` to see the accounts.",
      });
    }
    const resolved = await this.resolve(account).catch(() => undefined);
    const stored = await changing(account.id, async () => {
      const held = await readCredential(account.id);
      if (held !== undefined) await deleteCredential(account.id);
      return held;
    });
    // Never sent anywhere but the origin it was issued for.
    if (
      stored !== undefined &&
      resolved !== undefined &&
      credentialOrigin(resolved.location) === stored.origin
    ) {
      await revoke(resolved, stored.credential, signal);
    }
    return config;
  }

  /** Explicit and separate from signing out, because a job may still name it. */
  async remove(accountId: string, signal: AbortSignal): Promise<RegistryConfig> {
    const config = await readConfig();
    const account = config.accounts.find(({ id }) => id === accountId);
    if (account === undefined) {
      throw new AiregError(`No account named ${quoted(accountId)}.`, {
        code: ErrorCode.NotFound,
        hint: "Run `aireg auth list` to see the accounts.",
      });
    }
    const used = config.jobs.filter((job) => job.account === accountId).map(({ id }) => id);
    if (used.length > 0) {
      throw new AiregError(`The account is used by ${plural(used.length, "job")}: ${list(used)}.`, {
        code: ErrorCode.Conflict,
        hint:
          used.length === 1
            ? `Remove it first with \`aireg job remove ${used[0]}\`.`
            : "Remove them first with `aireg job remove <job>`.",
      });
    }
    if ((await readCredential(account.id)) !== undefined) await this.logout(accountId, signal);
    const latest = await readConfig();
    return writeConfig(
      { ...latest, accounts: latest.accounts.filter(({ id }) => id !== accountId) },
      latest.revision,
    );
  }

  /** Mints a credential-less row for a registry that needs no login. */
  async adopt(registry: string): Promise<Account> {
    const config = await readConfig();
    const existing = config.accounts.find((entry) => entry.registry === registry);
    if (existing !== undefined) return existing;
    const account: Account = { id: newAccountId(), registry };
    await writeConfig({ ...config, accounts: upsert(config.accounts, account) }, config.revision);
    return account;
  }

  /** The account's sign-in for `location`, refreshed when it is about to expire. */
  async credential(account: Account, location: string, signal: AbortSignal): Promise<Credential> {
    const credential = await this.signedInCredential(account, location, signal);
    if (credential === undefined) throw signedOut(account);
    return credential;
  }

  /** Whether the account's sign-in, if it has one, was issued for the origin of `location`. */
  async issuedFor(account: Account, location: string): Promise<boolean> {
    const stored = await readCredential(account.id);
    return stored !== undefined && stored.origin === credentialOrigin(location);
  }

  /** As `credential`, but undefined for an account that is signed out. */
  async signedInCredential(
    account: Account,
    location: string,
    signal: AbortSignal,
  ): Promise<Credential | undefined> {
    const stored = await readCredential(account.id);
    if (stored === undefined) return undefined;
    assertBound(account, stored, location);
    if (!expiring(stored.credential)) return stored.credential;
    const resolved = await this.resolve(account);
    if (resolved.adapter.auth?.refresh === undefined) {
      throw new AiregError(`The sign-in for ${account.registry} has expired.`, {
        code: ErrorCode.Unauthorized,
        hint: `Run \`aireg auth login ${account.registry}\`.`,
      });
    }
    assertBound(account, stored, resolved.location);
    const refresh = resolved.adapter.auth.refresh;
    return changing(account.id, async () => {
      const current = await readCredential(account.id);
      if (current === undefined) return undefined;
      assertBound(account, current, resolved.location);
      if (!expiring(current.credential)) return current.credential;
      const next = await refresh(resolved.location, current.credential, signal);
      await saveCredential(account.id, { origin: current.origin, credential: next });
      return next;
    });
  }

  async open(
    account: Account,
    alias: string,
    config: SourceConfig,
    signal: AbortSignal,
  ): Promise<{ adapter: SourceAdapter; context: SourceContext }> {
    const resolved = await this.resolve(account);
    const credential = await this.credential(account, resolved.location, signal);
    return {
      adapter: resolved.adapter,
      context: {
        source: {
          registry: alias,
          location: resolved.location,
          config,
          key: resolved.key,
        },
        credential,
        onBytes: () => {},
        signal,
        ...hostServices(resolved.adapter.id),
      },
    };
  }
}
