import type { LeaseHolder } from "#core/lease/holder.ts";
import type { Scope } from "#core/store/paths.ts";

/** `aireg unlock`: who holds the scope's write lock, or the lock it cleared. */
export type UnlockResult = Free | Held | Broken;

interface Free {
  scope: Scope;
  held: false;
}

interface Held {
  scope: Scope;
  held: true;
  holder: LeaseHolder;
}

/** After `aireg unlock <id>`. */
interface Broken {
  scope: Scope;
  broken: LeaseHolder;
}
