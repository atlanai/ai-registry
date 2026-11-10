import { messageOf } from "#adapter/errors.ts";
import type { CommandContext } from "#cli/commands/command.ts";
import { STREAMED } from "#cli/commands/define.ts";
import { list } from "#cli/commands/registry/list.ts";
import type { Options } from "#cli/commands/registry/options.ts";
import type { PublishedArtifact } from "#cli/commands/registry/result.ts";
import { show } from "#cli/commands/registry/show.ts";
import { underHome } from "#cli/render/home.ts";
import type { Scope } from "#core/store/paths.ts";
import type { CommonOptions } from "#engine/options.ts";

export interface Catalog {
  name: string;
  /** Under `~` where it is in the home folder, without credentials. */
  address: string;
  entries: PublishedArtifact[];
  /** Why the registry did not list its artifacts; undefined while it is read or when it did. */
  error: string | undefined;
  /** True until its first read ends: a slow registry holds up no other. */
  loading: boolean;
}

/** How long a page waits for catalogs before it draws with what it has. */
const WAIT_MS = 1500;
/** A catalog is read again after this, and one that failed no sooner than this. */
const FRESH_MS = 30_000;
const RETRY_MS = 60_000;

const common = (scope: Scope): CommonOptions => ({
  scope,
  targets: undefined,
  select: undefined,
  yes: true,
  all: false,
  dryRun: false,
  frozen: false,
  force: false,
  copy: false,
});

const options = (argument: string | undefined, scope: Scope): Options => ({
  argument,
  flags: {},
  common: common(scope),
});

/** These actions return their data; neither streams. */
function returned<T>(result: T | typeof STREAMED): T {
  if (result === STREAMED) throw new Error("A registry action streamed instead of returning.");
  return result;
}

interface Kept {
  read: { entries: PublishedArtifact[] } | { error: string } | undefined;
  atMs: number;
  pending: Promise<void> | undefined;
}

/**
 * The registries `aireg registry list -g` declares and what `aireg registry show` lists for
 * each, read in process with the commands' own code. Each catalog is kept and refreshed on
 * its own schedule.
 */
export class Catalogs {
  readonly #kept = new Map<string, Kept>();
  readonly #context: CommandContext;

  constructor(context: CommandContext) {
    this.#context = context;
  }

  async read(scope: Scope): Promise<{ catalogs: Catalog[]; problem: string | undefined }> {
    let declared: { registry: string; address: string }[];
    try {
      declared = returned(await list.run(options(undefined, scope), this.#context)).data.registries;
    } catch (error) {
      return { catalogs: [], problem: messageOf(error) };
    }
    const kept = declared.map((entry) => this.#refresh(entry.registry, scope));
    const waiting = kept.flatMap((entry) => (entry.pending === undefined ? [] : [entry.pending]));
    if (waiting.length > 0) {
      await Promise.race([
        Promise.all(waiting),
        new Promise((resolve) => setTimeout(resolve, WAIT_MS)),
      ]);
    }
    return {
      catalogs: declared.map((entry, at) => {
        const read = kept[at]?.read;
        return {
          name: entry.registry,
          address: underHome(entry.address),
          entries: read !== undefined && "entries" in read ? read.entries : [],
          error: read !== undefined && "error" in read ? read.error : undefined,
          loading: read === undefined,
        };
      }),
      problem: undefined,
    };
  }

  #refresh(name: string, scope: Scope): Kept {
    const id = `${scope}\u0000${name}`;
    const kept = this.#kept.get(id) ?? { read: undefined, atMs: 0, pending: undefined };
    this.#kept.set(id, kept);
    const age = Date.now() - kept.atMs;
    const due = kept.read === undefined || age > ("error" in kept.read ? RETRY_MS : FRESH_MS);
    if (due && kept.pending === undefined) {
      kept.pending = show
        .run(options(name, scope), this.#context)
        // A failure anywhere, reading or unwrapping, ends the read and says why.
        .then((shown): Kept["read"] => ({ entries: returned(shown).entries }))
        .catch((error: unknown) => ({ error: messageOf(error) }))
        .then((read) => {
          kept.read = read;
          kept.atMs = Date.now();
          kept.pending = undefined;
        });
    }
    return kept;
  }
}
