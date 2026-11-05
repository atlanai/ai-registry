import type { Account } from "#core/config/model.ts";

/** One account, with whether it is signed in and whether its registry signs in at all. */
export interface ListedAccount extends Account {
  signedIn: boolean;
  needsSignIn: boolean;
}

export interface AuthList {
  accounts: ListedAccount[];
}

/** Who the registry says signed in, and the account it acts within where it has one. */
export interface SignedInAs {
  name: string;
  account?: string;
}

/** `identity` is present only when the registry reports one. */
export interface AuthLogin {
  account: Account;
  identity?: SignedInAs;
}

/** `aireg auth logout` and `remove`. */
export interface AuthAccountId {
  accountId: string;
}
