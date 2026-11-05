import { heldAt } from "#accounts/registry.ts";
import { plural, withoutCredentials } from "#adapter/text.ts";
import type { AuthList, ListedAccount } from "#cli/commands/auth/result.ts";
import { comparableLocation } from "#core/adapter/identity.ts";
import { expandLocation } from "#core/adapter/location.ts";
import { readConfig } from "#core/config/repository.ts";
import { signedInAccounts } from "#core/credentials/store.ts";
import { AiregError, ErrorCode } from "#core/errors.ts";
import type { RegistrySource } from "#core/manifest/model.ts";
import { readManifest } from "#core/manifest/repository.ts";
import { roots } from "#core/store/paths.ts";
import type { Printer } from "#core/term/printer.ts";
import { table } from "#core/term/table.ts";
import { locate } from "#engine/scope/locate.ts";
import { needsSignIn } from "./shared.ts";

export async function list(): Promise<AuthList> {
  const config = await readConfig();
  const signedIn = await signedInAccounts();
  const needs = new Map(
    await Promise.all(
      config.accounts.map(async (account) => [account.id, await needsSignIn(account)] as const),
    ),
  );
  return {
    accounts: config.accounts.map((account) => ({
      ...account,
      signedIn: signedIn.has(account.id),
      needsSignIn: needs.get(account.id) ?? true,
    })),
  };
}

export function printList({ accounts }: AuthList, printer: Printer): void {
  if (accounts.length === 0) {
    printer.info("No accounts yet.");
    printer.hint("Run `aireg auth login <registry>` to sign in.");
    return;
  }
  const { style } = printer;
  printer.info(style.bold(plural(accounts.length, "account")));
  table(
    printer,
    [
      { header: "registry", value: (row: ListedAccount) => row.registry },
      {
        header: "state",
        value: (row: ListedAccount) => {
          if (!row.needsSignIn) return style.dim("no sign-in");
          return row.signedIn ? style.green("signed in") : style.yellow("signed out");
        },
      },
      {
        header: "namespace",
        value: (row: ListedAccount) => row.defaultNamespace ?? "",
        optional: true,
      },
      { header: "account", value: (row: ListedAccount) => style.dim(row.id) },
    ],
    accounts,
  );
}

export interface Declared {
  source: RegistrySource;
  location: string;
  /** Only the project declares it, so signing in declares it for the user too. */
  projectOnly: boolean;
}

/** Project before user, as `aireg add` finds it; an account is the user's, so one alias has one source. */
export async function declared(alias: string, cwd: string): Promise<Declared | undefined> {
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

export async function heldFor(
  alias: string,
  address: string,
  cwd: string,
): Promise<Declared | undefined> {
  const { registries } = await readManifest(roots("user", cwd).manifest);
  const held = heldAt(registries, alias, address, cwd);
  return held === undefined
    ? undefined
    : { source: held, location: expandLocation(held.location, cwd), projectOnly: false };
}
